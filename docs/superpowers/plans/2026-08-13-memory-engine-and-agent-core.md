# openreverie Memory Engine and Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build openreverie sub-project 1: a local-first memory engine and agent core behind a terminal CLI, per the approved spec.

**Architecture:** Truth lives in a memory folder (markdown prose plus an append-only graph.jsonl); SQLite is a derived, rebuildable index. A provider layer abstracts chat and embeddings (OpenAI adapters first). The agent core assembles session context, dispatches memory tools, and enforces one of two safety modes. The CLI is a thin REPL plus a setup wizard.

**Tech Stack:** TypeScript (strict, NodeNext), Node 22+, pnpm workspace, better-sqlite3 (FTS5), gray-matter, ulid, zod, smol-toml, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-08-13-openreverie-design.md` (read it before implementing any task).

## Global Constraints

- Read `AGENTS.md` fully before working. Its writing rules apply to every string in this repo: never use em dashes; avoid the banned trope words; plain honest prose everywhere, including error messages and commit messages.
- Package dependency direction is `cli -> core -> memory -> providers`, downward only.
- Only `@openreverie/providers` may talk to a vendor API. Everything else consumes the interfaces.
- Transcripts are append-only. No code path may modify or delete a transcript line.
- Nothing may exist only in SQLite. `index.db` must always be rebuildable from the folder.
- All LLM structured output is validated with zod at the boundary; one retry with the validation error fed back, then degrade gracefully.
- Prose file writes are atomic (temp file then rename). Graph and JSONL writes are single-line appends.
- No telemetry, no analytics, no network calls except the configured provider.
- Test fixtures are always synthetic. Never real personal data.
- TDD: write the failing test first for all deterministic logic. Run tests from the repo root with `pnpm vitest run <path>` unless stated otherwise.
- Commit after each task with a plain message: what changed and why.

## File Structure

```
packages/providers/src/
  types.ts        Chat/embedding interfaces, message and tool types
  fakes.ts        FakeChatProvider, FakeEmbeddingProvider (exported for tests everywhere)
  openai.ts       OpenAiChatProvider, OpenAiEmbeddingProvider, SSE parsing
  factory.ts      createChatProvider / createEmbeddingProvider from a selection object
  index.ts        Re-exports
packages/memory/src/
  paths.ts        MemoryPaths, ensureMemoryTree
  documents.ts    Document read/write (gray-matter), atomic writes, ULID ids
  graph.ts        Graph record types, append, fold, read
  transcripts.ts  SessionStore: session dirs, JSONL transcript append, unreflected scan
  proposals.ts    Proposal queue over proposals.jsonl
  sqlite.ts       MemoryIndex: schema, upserts, FTS search, vector search, graph tables
  retrieval.ts    Hybrid search (RRF merge), filters
  rollups.ts      Pending-rollup date logic (pure) and LLM rollup builders
  reflection.ts   Zod output schema, reflection call, applyReflection (confidence split)
  gitSync.ts      Best-effort git init/add/commit of the memory folder
  engine.ts       MemoryEngine facade used by core
  index.ts        Re-exports
packages/core/src/
  config.ts       Config schema (zod), TOML load/save, key resolution, defaults
  personas.ts     Companion and firewall persona prompts, crisis resource rendering
  context.ts      assembleSystemPrompt from engine state
  tools.ts        Tool definitions and dispatch to the engine
  agent.ts        AgentSession: streaming loop, tool rounds, end-of-session reflection
  index.ts        Re-exports
packages/cli/src/
  setup.ts        First-run wizard (readline), writes config.toml
  chat.ts         Terminal chat REPL rendering AgentEvents
  index.ts        Entry: subcommands chat (default), setup, reindex, reflect
```

## Execution DAG (parallelization)

- **Wave 1 (parallel):** Task A1, Task B1, Task B2, Task B3, Task B4, Task C1, Task C2
- **Wave 2 (parallel, after A1):** Task A2, Task A3, Task B5 (needs A1 fakes), Task B7
- **Wave 3 (parallel):** Task B6 (needs B5), Task B8 (needs B7, A1), Task B9 (needs B1, B2, B4, A1), Task B10
- **Wave 4:** Task B11 (needs all B tasks and A1)
- **Wave 5 (parallel):** Task C3, Task C4, Task C5 (need B11, C1, C2)
- **Wave 6 (parallel):** Task D1 (needs C1), Task D2 (needs C5)
- **Wave 7:** Task D3 (needs everything)

---

### Task A1: Provider types and fakes

**Files:**
- Create: `packages/providers/src/types.ts`, `packages/providers/src/fakes.ts`, `packages/providers/src/index.ts` (replace placeholder)
- Test: `packages/providers/src/fakes.test.ts`

**Interfaces:**
- Produces (all later tasks depend on these exact names):

```ts
export type Role = 'system' | 'user' | 'assistant' | 'tool'
export interface ToolCall { id: string; name: string; arguments: string }
export interface ChatMessage { role: Role; content: string; toolCalls?: ToolCall[]; toolCallId?: string }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface ChatRequest {
  model: string
  system?: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
}
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'done' }
export interface ChatResult { text: string; toolCalls: ToolCall[] }
export interface ChatProvider {
  readonly name: string
  complete(req: ChatRequest): Promise<ChatResult>
  stream(req: ChatRequest): AsyncIterable<ChatEvent>
}
export interface EmbeddingProvider {
  readonly name: string
  embed(model: string, texts: string[]): Promise<number[][]>
}
export type FetchLike = typeof fetch
```

- `FakeChatProvider`: constructed with `ChatResult[]`; `complete` returns them in order (throws when exhausted); `stream` yields the next result's text as one `text` event, then each tool call, then `done`. Records every request in `public requests: ChatRequest[]`.
- `FakeEmbeddingProvider`: deterministic 8-dimension vectors. Component `i` of a text's vector is derived from a simple string hash of `text + ':' + i`, then the vector is L2 normalized. Same text always gives the same vector; different texts differ.

- [ ] **Step 1: Write failing tests** covering: fake chat returns scripted results in order and records requests; fake stream yields text, tool calls, done; fake embeddings are deterministic, normalized (length within 1e-6 of 1), and distinct for distinct texts.

```ts
import { describe, expect, it } from 'vitest'
import { FakeChatProvider, FakeEmbeddingProvider } from './fakes.js'

describe('FakeChatProvider', () => {
  it('returns scripted results in order and records requests', async () => {
    const fake = new FakeChatProvider([
      { text: 'one', toolCalls: [] },
      { text: 'two', toolCalls: [{ id: 'c1', name: 'search_memory', arguments: '{"query":"x"}' }] },
    ])
    const r1 = await fake.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(r1.text).toBe('one')
    const events: string[] = []
    for await (const e of fake.stream({ model: 'm', messages: [] })) events.push(e.type)
    expect(events).toEqual(['text', 'tool_call', 'done'])
    expect(fake.requests).toHaveLength(2)
  })
})

describe('FakeEmbeddingProvider', () => {
  it('is deterministic, normalized, and distinct', async () => {
    const fake = new FakeEmbeddingProvider()
    const [a1] = await fake.embed('m', ['hello'])
    const [a2, b] = await fake.embed('m', ['hello', 'world'])
    expect(a1).toEqual(a2)
    expect(a1).not.toEqual(b)
    const norm = Math.sqrt(a1!.reduce((s, v) => s + v * v, 0))
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6)
  })
})
```

- [ ] **Step 2: Run and verify failure** (`pnpm vitest run packages/providers`), then implement `types.ts` exactly as above and `fakes.ts`:

```ts
// fakes.ts (core logic)
function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake'
  async embed(_model: string, texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const raw = Array.from({ length: 8 }, (_, i) => (hash32(`${t}:${i}`) % 2000) / 1000 - 1)
      const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1
      return raw.map((v) => v / norm)
    })
  }
}
```

`FakeChatProvider` keeps a cursor into the scripted array; both `complete` and `stream` advance it and push onto `requests`.

- [ ] **Step 3: Verify tests pass, update `index.ts` to re-export types and fakes, run `pnpm build && pnpm lint`, commit** (`feat: provider interfaces and test fakes`).

---

### Task A2: OpenAI chat adapter

**Files:**
- Create: `packages/providers/src/openai.ts`
- Test: `packages/providers/src/openai.test.ts` and fixture `packages/providers/src/fixtures/openai-stream.txt`

**Interfaces:**
- Consumes: types from Task A1.
- Produces: `export interface OpenAiConfig { apiKey: string; baseUrl?: string }` (baseUrl defaults to `https://api.openai.com/v1`) and `export class OpenAiChatProvider implements ChatProvider { constructor(cfg: OpenAiConfig, fetchImpl?: FetchLike) }`.

Implementation notes (the how):
- `complete` POSTs to `${baseUrl}/chat/completions` with `stream: false`. Map `ChatRequest.system` to a leading `{role:'system'}` message; map `toolCalls`/`toolCallId` to OpenAI's `tool_calls`/`tool_call_id` shapes; map `tools` to `{type:'function', function:{name, description, parameters}}`. Map the response's `choices[0].message` back to `ChatResult`.
- `stream` POSTs with `stream: true` and parses SSE from `res.body`: split on newlines, lines starting with `data: `, stop at `data: [DONE]`. Accumulate `delta.content` into `text` events (emit per chunk) and assemble `delta.tool_calls` fragments by `index` (id and name arrive first, `function.arguments` arrives in pieces); emit each completed `tool_call` when the stream ends or `finish_reason` arrives, then `done`.
- Non-2xx responses throw `new Error('openai: HTTP <status>: <body first 200 chars>')`.
- Contract tests use an injected fake `fetch` returning canned JSON (complete) and a `ReadableStream` built from the SSE fixture file (stream). The fixture must include a text-only response and a response with one tool call whose arguments arrive split across two chunks.

- [ ] **Step 1: Write the SSE fixture and failing tests**: `complete` maps request and response shapes correctly (assert the outgoing body: model, messages incl. system, tools shape); `stream` yields the right event sequence from the fixture and reassembles split tool-call arguments into valid JSON; non-2xx throws with status in the message.
- [ ] **Step 2: Verify failure, implement `openai.ts` (request mapping, SSE parser as described), verify pass.**
- [ ] **Step 3: Run `pnpm build && pnpm lint`, commit** (`feat: OpenAI chat adapter with streaming and tool calls`).

---

### Task A3: OpenAI embeddings adapter and provider factory

**Files:**
- Create: `packages/providers/src/factory.ts`; extend `packages/providers/src/openai.ts`
- Test: `packages/providers/src/factory.test.ts` (covers both)

**Interfaces:**
- Produces:

```ts
export class OpenAiEmbeddingProvider implements EmbeddingProvider { constructor(cfg: OpenAiConfig, fetchImpl?: FetchLike) }
export interface ProviderSelection { provider: 'openai'; apiKey: string; baseUrl?: string }
export function createChatProvider(sel: ProviderSelection, fetchImpl?: FetchLike): ChatProvider
export function createEmbeddingProvider(sel: ProviderSelection, fetchImpl?: FetchLike): EmbeddingProvider
```

- `embed` POSTs `{model, input: texts}` to `${baseUrl}/embeddings`, returns `data[i].embedding` ordered by `data[i].index`. Batches over 100 texts into multiple requests, concatenated in order.
- Factory switches on `sel.provider`; unknown provider throws `Error('unknown provider: <name>')`. This is the single place future adapters (anthropic, openrouter, and the rest) get registered.

- [ ] **Step 1: Failing tests**: embed maps input/output and preserves order across a 150-text batch (fake fetch records call count = 2); factory returns OpenAI instances and throws on unknown provider.
- [ ] **Step 2: Implement, verify pass, update `index.ts` re-exports, `pnpm build && pnpm lint`, commit** (`feat: OpenAI embeddings adapter and provider factory`).

---

### Task B1: Memory paths and documents

**Files:**
- Create: `packages/memory/src/paths.ts`, `packages/memory/src/documents.ts`; replace `packages/memory/src/index.ts` with re-exports
- Modify: `packages/memory/package.json` (add deps: `gray-matter`, `ulid`, `zod`); root `package.json` (add `pnpm.onlyBuiltDependencies: ["better-sqlite3"]` for Task B5)
- Test: `packages/memory/src/documents.test.ts`

**Interfaces:**
- Produces:

```ts
// paths.ts
export interface MemoryPaths {
  root: string; constitution: string; realmsDir: string; arcsDir: string
  sessionsDir: string; rollupsDailyDir: string; rollupsWeeklyDir: string
  graphLog: string; proposals: string; indexDb: string
}
export function memoryPaths(root: string): MemoryPaths
export async function ensureMemoryTree(paths: MemoryPaths): Promise<void>
// documents.ts
export type IdPrefix = 'doc' | 'item' | 'arc' | 'realm' | 'session' | 'person' | 'prop'
export function newId(prefix: IdPrefix): string // `${prefix}_${ulid()}`
export interface DocumentMeta { id: string; [key: string]: unknown }
export interface Document { path: string; meta: DocumentMeta; body: string }
export async function readDocument(path: string): Promise<Document>
export async function writeDocumentAtomic(doc: Document): Promise<void>
export async function listDocuments(dir: string): Promise<Document[]> // *.md, sorted by path
```

- `ensureMemoryTree` creates all directories and seeds `constitution.md` (with a fresh `doc_` id and a short honest starter body: "This constitution is empty. It grows as we talk.") only if missing.
- `writeDocumentAtomic`: serialize with gray-matter (`matter.stringify(body, meta)`), write to `<path>.tmp-<ulid>` in the same directory, then `fs.rename`. Reject documents whose meta lacks `id`.
- `readDocument` throws a plain Error naming the path if the file lacks frontmatter `id`.

- [ ] **Step 1: Failing tests** in a `fs.mkdtemp` sandbox: round-trip write/read preserves meta and body; ensureMemoryTree is idempotent and seeds constitution once; atomic write leaves no `.tmp-` files; write without id rejects; listDocuments returns sorted docs and ignores non-md files.
- [ ] **Step 2: Implement, verify pass, `pnpm build && pnpm lint`, commit** (`feat: memory folder layout and atomic document store`).

---

### Task B2: Graph log

**Files:**
- Create: `packages/memory/src/graph.ts`
- Test: `packages/memory/src/graph.test.ts`

**Interfaces:**
- Produces:

```ts
export type NodeType = 'realm' | 'arc' | 'item' | 'session' | 'person' | 'entity'
export type EdgeType = 'part_of' | 'in' | 'from' | 'involves' | 'relates_to'
export interface NodeRecord { ts: string; op: 'assert' | 'retract'; node: string; type: NodeType; label: string; doc?: string }
export interface EdgeRecord {
  ts: string; op: 'assert' | 'retract'; edge: EdgeType; from: string; to: string
  confidence: number; source?: string; confirmed: boolean
}
export type GraphRecord = NodeRecord | EdgeRecord
export interface GraphNode { id: string; type: NodeType; label: string; doc?: string; ts: string }
export interface GraphEdge { edge: EdgeType; from: string; to: string; confidence: number; source?: string; confirmed: boolean; ts: string }
export interface GraphState { nodes: Map<string, GraphNode>; edges: Map<string, GraphEdge> }
export function edgeKey(e: { edge: EdgeType; from: string; to: string }): string // `${edge}:${from}:${to}`
export function foldGraph(records: GraphRecord[]): GraphState
export async function appendGraph(paths: MemoryPaths, records: GraphRecord[]): Promise<void>
export async function readGraph(paths: MemoryPaths): Promise<GraphState>
```

- Fold semantics: later records win; `retract` removes the node or edge from current state (history stays in the file). Re-asserting a retracted edge brings it back with the new attributes. A node retract does not cascade to edges (edges to missing nodes are simply dangling; queries skip them).
- `appendGraph` writes one JSON line per record with `fs.appendFile`. `readGraph` tolerates and skips blank lines and reports (throws) on unparseable lines with the line number.

- [ ] **Step 1: Failing tests**: assert then retract then re-assert folds correctly for nodes and edges; edge identity is (edge, from, to) so a second assert updates confidence/confirmed in place; append/read round-trips through a temp file; unparseable line throws with line number.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: append-only graph log with fold`).

---

### Task B3: Transcript session store

**Files:**
- Create: `packages/memory/src/transcripts.ts`
- Test: `packages/memory/src/transcripts.test.ts`

**Interfaces:**
- Consumes: `ToolCall` from providers, `MemoryPaths`, `newId`.
- Produces:

```ts
export interface TranscriptLine {
  ts: string; role: 'user' | 'assistant' | 'tool'; content: string
  toolCalls?: ToolCall[]; toolCallId?: string
}
export class SessionStore {
  readonly sessionId: string // 'session_<ulid>'
  readonly dir: string       // sessions/YYYY-MM-DD-<sessionId>
  static async start(paths: MemoryPaths, now: Date): Promise<SessionStore>
  static async open(paths: MemoryPaths, sessionId: string): Promise<SessionStore>
  async appendLine(line: TranscriptLine): Promise<void>
  static async readTranscript(paths: MemoryPaths, sessionId: string): Promise<TranscriptLine[]>
  static async listSessions(paths: MemoryPaths): Promise<{ sessionId: string; date: string; reflected: boolean }[]>
}
```

- `start` creates the session directory and an empty `transcript.jsonl`. A session is `reflected` when `summary.md` exists in its directory. `listSessions` scans `sessionsDir` and derives `date` from the directory name prefix.
- There is deliberately no delete or rewrite API. Do not add one.

- [ ] **Step 1: Failing tests**: start creates dir named with date and id; appendLine then readTranscript round-trips lines in order; listSessions reports reflected false before and true after a `summary.md` is written into the dir; open finds an existing session by id.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: append-only transcript session store`).

---

### Task B4: Proposals queue

**Files:**
- Create: `packages/memory/src/proposals.ts`
- Test: `packages/memory/src/proposals.test.ts`

**Interfaces:**
- Produces:

```ts
export type ProposalKind = 'new_arc' | 'new_person' | 'link'
export interface Proposal {
  id: string // 'prop_<ulid>'
  ts: string
  kind: ProposalKind
  summary: string // one human sentence the agent can say out loud
  payload: Record<string, unknown> // kind-specific, e.g. {name, realm} or an EdgeRecord-shaped link
  source: string  // session id
}
export type ProposalResolution = 'accepted' | 'rejected'
export async function appendProposals(paths: MemoryPaths, proposals: Proposal[]): Promise<void>
export async function pendingProposals(paths: MemoryPaths): Promise<Proposal[]>
export async function resolveProposal(paths: MemoryPaths, id: string, resolution: ProposalResolution): Promise<void>
```

- Storage is `proposals.jsonl`, append-only like the graph: proposal lines and resolution lines (`{op:'resolve', id, resolution, ts}`); pending = proposals with no resolution, oldest first.

- [ ] **Step 1: Failing tests**: append two, both pending in order; resolve one, only the other pending; resolving twice is a no-op; resolving an unknown id throws.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: append-only proposal queue`).

---

### Task B5: SQLite index

**Files:**
- Create: `packages/memory/src/sqlite.ts`
- Modify: `packages/memory/package.json` (add `better-sqlite3`; dev `@types/better-sqlite3`)
- Test: `packages/memory/src/sqlite.test.ts`

**Interfaces:**
- Consumes: `Document`, `GraphState`, `FakeEmbeddingProvider` (tests only).
- Produces:

```ts
export type DocKind = 'constitution' | 'realm' | 'arc' | 'summary' | 'rollup_daily' | 'rollup_weekly'
export interface IndexedChunk { docId: string; path: string; kind: DocKind; seq: number; text: string }
export interface SearchHit { docId: string; path: string; kind: DocKind; snippet: string; score: number }
export type EmbedFn = (texts: string[]) => Promise<number[][]>
export class MemoryIndex {
  static open(dbPath: string): MemoryIndex
  close(): void
  async upsertDocument(doc: Document, kind: DocKind, embed: EmbedFn): Promise<void>
  removeDocument(docId: string): void
  replaceGraph(graph: GraphState): void
  searchText(query: string, limit: number): SearchHit[]
  async searchVector(queryVec: number[], limit: number): Promise<SearchHit[]>
  neighbors(nodeId: string): { edge: GraphEdge; node: GraphNode }[]
  itemsInArc(arcId: string): GraphNode[]
  arcsInvolvingPerson(personId: string): GraphNode[]
  nodeById(nodeId: string): GraphNode | undefined
}
```

- Schema: `documents(id PRIMARY KEY, path, kind, mtime)`, `chunks(id INTEGER PK, doc_id, seq, text)`, `chunks_fts` (FTS5, content=chunks), `embeddings(chunk_id PK, vector BLOB)`, `nodes(id PK, type, label, doc, ts)`, `edges(edge, from_id, to_id, confidence, confirmed, ts, PRIMARY KEY(edge, from_id, to_id))`.
- Chunking: split body on blank-line paragraph boundaries, greedily packing paragraphs into chunks of at most 1200 characters. Items in a summary's frontmatter (`meta.items` array) are indexed as one chunk each with the item id prefixed to the text.
- Vectors are Float32Array blobs. `searchVector` computes cosine against all embeddings in JS (fine at one-person scale; swap for a vector extension later without changing this interface).
- `upsertDocument` deletes the doc's old chunks/embeddings then reinserts. `replaceGraph` wipes and reloads nodes/edges tables inside one transaction, skipping edges whose endpoints are missing.

- [ ] **Step 1: Failing tests**: upsert then searchText finds the doc with a snippet; re-upsert with changed body drops stale hits; searchVector ranks an exact-text vector match above others (use FakeEmbeddingProvider vectors); replaceGraph then neighbors/itemsInArc/arcsInvolvingPerson return the folded relationships and skip dangling edges; open on a fresh path creates the schema, open on existing reuses it.
- [ ] **Step 2: Implement, verify pass (run `pnpm install` first for better-sqlite3), commit** (`feat: rebuildable SQLite index with FTS and vectors`).

---

### Task B6: Hybrid retrieval

**Files:**
- Create: `packages/memory/src/retrieval.ts`
- Test: `packages/memory/src/retrieval.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SearchFilters { kinds?: DocKind[]; after?: string; before?: string } // ISO date bounds compared against doc meta date when present
export async function searchMemory(
  index: MemoryIndex, embeddings: EmbeddingProvider, embeddingModel: string,
  query: string, filters?: SearchFilters, limit?: number, // default 8
): Promise<SearchHit[]>
```

- Method: take top 20 from `searchText` and top 20 from `searchVector` (embedding the query once), merge with reciprocal rank fusion (`score = sum over lists of 1/(60 + rank)`), dedupe by docId keeping best snippet, apply filters, return top `limit`.

- [ ] **Step 1: Failing tests** (FakeEmbeddingProvider, small seeded index): a doc ranked top by both lists beats a doc in one list; kind filter excludes; limit respected.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: hybrid retrieval with rank fusion`).

---

### Task B7: Rollup date logic (pure)

**Files:**
- Create: `packages/memory/src/rollups.ts` (pure functions only in this task)
- Test: `packages/memory/src/rollups.test.ts`

**Interfaces:**
- Produces:

```ts
export function isoWeekOf(date: string): string // '2026-08-13' -> '2026-W33', ISO 8601 week rules
export function pendingDailyRollups(sessionDates: string[], existingDailies: string[], today: string): string[]
export function pendingWeeklyRollups(dailyDates: string[], existingWeeklies: string[], today: string): string[]
```

- A daily is pending for any date strictly before `today` that has at least one session and no daily rollup. A weekly is pending for any ISO week strictly before the week of `today` that has at least one daily rollup and no weekly rollup. Results sorted ascending.

- [ ] **Step 1: Failing tests**: isoWeekOf handles a year boundary (2026-01-01 is 2026-W01; 2027-01-01 is 2026-W53) and a mid-year date; pending functions honor the strictly-before rule (today's sessions never pending) and skip covered periods.
- [ ] **Step 2: Implement (no Date.parse ambiguity: construct `Date.UTC` from split parts), verify pass, commit** (`feat: lazy rollup trigger logic`).

---

### Task B8: Rollup builders

**Files:**
- Modify: `packages/memory/src/rollups.ts` (add builders)
- Test: extend `packages/memory/src/rollups.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RollupDeps { chat: ChatProvider; model: string; paths: MemoryPaths }
export async function buildDailyRollup(deps: RollupDeps, date: string): Promise<Document>
export async function buildWeeklyRollup(deps: RollupDeps, week: string): Promise<Document>
```

- `buildDailyRollup` reads that date's session summaries (`listSessions` + `readDocument`), prompts `chat.complete` with them ("Synthesize this day in this person's life into a short honest rollup: what happened, what they felt, what moved. Plain prose, no headings, no em dashes."), and writes `rollups/daily/<date>.md` atomically with meta `{id: newId('doc'), kind: 'rollup_daily', date}`. Weekly reads that week's dailies and writes `rollups/weekly/<week>.md` with `{kind: 'rollup_weekly', week}`. Both return the written Document. Zero-source periods throw (callers only pass pending periods, which require sources).

- [ ] **Step 1: Failing tests** with FakeChatProvider: daily writes the file with the fake's text and correct meta, and the prompt sent to the fake contains the summary bodies; weekly likewise from dailies.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: daily and weekly rollup builders`).

---

### Task B9: Reflection pipeline

**Files:**
- Create: `packages/memory/src/reflection.ts`
- Test: `packages/memory/src/reflection.test.ts`

**Interfaces:**
- Produces:

```ts
export const CONFIDENCE_THRESHOLD = 0.8
export interface ReflectionItem { id: string; text: string; kind: 'observation' | 'feeling' | 'event' | 'intention'; ts: string }
export const reflectionOutputSchema: z.ZodType<ReflectionOutput> // see shape below
export interface ReflectionOutput {
  summary: string
  items: { text: string; kind: 'observation' | 'feeling' | 'event' | 'intention' }[]
  attributions: { itemIndex: number; arcId: string; confidence: number }[]
  newArcs: { name: string; realm: string; reason: string; itemIndexes: number[] }[]
  newPersons: { name: string; reason: string; itemIndexes: number[] }[]
  arcNarratives: { arcId: string; narrative: string }[] // full replacement body for the arc page
  constitutionUpdate: string | null // full replacement body, rare
}
export interface ReflectionContext { constitution: string; arcs: GraphNode[]; realms: GraphNode[] }
export async function reflectSession(
  deps: { chat: ChatProvider; model: string },
  transcript: TranscriptLine[], context: ReflectionContext,
): Promise<ReflectionOutput | { summary: string; degraded: true }>
export async function applyReflection(
  paths: MemoryPaths, out: ReflectionOutput, sessionId: string, liveItems: ReflectionItem[], now: Date,
): Promise<{ summaryDoc: Document; autoAsserted: number; proposals: Proposal[] }>
```

- `reflectSession` prompt: the persona-free reflection instruction (you are the memory pipeline, not the companion), the constitution, the arc and realm listings with ids, then the transcript rendered as `role: content` lines; instructs the model to answer with only JSON matching the schema (include the JSON shape in the prompt). Parse with `reflectionOutputSchema`. On zod failure, retry once appending the validation error and the previous raw output; on second failure, return `{summary: <raw text or a plain fallback line>, degraded: true}`.
- `applyReflection` does, in order:
  1. Mint `ReflectionItem`s from `out.items` (newId('item'), ts = now), merge `liveItems` (dedupe by case-insensitive exact text).
  2. Write `summary.md` in the session dir: meta `{id: newId('doc'), kind: 'summary', session: sessionId, date, items: ReflectionItem[]}`, body = summary. This flips the session to reflected.
  3. Graph appends: a node per item (`type:'item'`, doc = summary path); `from` edges item to session; for each attribution with `confidence >= CONFIDENCE_THRESHOLD` whose arcId exists in the graph, assert `part_of` with `confirmed: false`; below threshold or unknown arcId becomes a `link` proposal instead.
  4. Each `newArcs` and `newPersons` entry becomes a proposal (never auto-created).
  5. For each `arcNarratives` whose arc exists: rewrite that arc doc's body atomically (meta untouched except `updated` timestamp).
  6. If `constitutionUpdate` is non-null, rewrite constitution body the same way.
- `applyReflection` never touches the network and is deterministic given its inputs (tests rely on this).

- [ ] **Step 1: Failing tests**: happy path with a scripted FakeChatProvider JSON reply (summary written with items in meta; high-confidence attribution asserted unconfirmed; low-confidence one queued as proposal; new arc queued not created; arc narrative rewritten; constitution untouched when null); malformed then valid JSON consumes two fake results (retry works); two malformed results degrade to summary-only and still write summary.md; live item dedupe.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: reflection pipeline with confidence-split attribution`).

---

### Task B10: Git sync

**Files:**
- Create: `packages/memory/src/gitSync.ts`
- Test: `packages/memory/src/gitSync.test.ts`

**Interfaces:**
- Produces: `export async function commitMemory(root: string, message: string): Promise<{ ok: boolean; warning?: string }>`
- Behavior: if `root/.git` missing, run `git init -q` (and set a local user.name "reverie" / user.email "reverie@local" so commits work everywhere); then `git add -A` and `git commit -q -m <message>`; "nothing to commit" counts as ok. Any failure returns `{ok:false, warning}` and never throws. Use `child_process.execFile` with `cwd: root`.

- [ ] **Step 1: Failing tests** in a temp dir: first call initializes and commits; second call with no changes is ok; a file change produces a second commit (`git rev-list --count HEAD` = 2); a root that is not a directory returns ok false with warning.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: best-effort git versioning of the memory folder`).

---

### Task B11: MemoryEngine facade

**Files:**
- Create: `packages/memory/src/engine.ts`; update `packages/memory/src/index.ts` re-exports
- Test: `packages/memory/src/engine.test.ts` (integration-style, FakeChat + FakeEmbeddings, temp dir)

**Interfaces:**
- Consumes: everything from B1-B10 and A1.
- Produces (this is the exact surface core builds on):

```ts
export interface EngineDeps {
  chat: ChatProvider; embeddings: EmbeddingProvider
  reflectionModel: string; embeddingModel: string
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
export class MemoryEngine {
  static async open(root: string, deps: EngineDeps): Promise<MemoryEngine> // ensureMemoryTree, open index, runMaintenance
  async close(): Promise<void>
  async startSession(now?: Date): Promise<string> // sessionId
  async appendTranscript(sessionId: string, line: TranscriptLine): Promise<void>
  async remember(sessionId: string, text: string, kind?: ReflectionItem['kind']): Promise<void> // live capture, session-scoped scratch
  async endSession(sessionId: string): Promise<void> // reflect, apply, reindex touched docs, git commit
  async sessionContext(now?: Date): Promise<SessionContext>
  async search(query: string, filters?: SearchFilters, limit?: number): Promise<SearchHit[]>
  graphQuery(q: GraphQuery): unknown[]
  async readDocumentById(docId: string): Promise<Document | null>
  async readTranscript(sessionId: string): Promise<TranscriptLine[]>
  listArcs(): GraphNode[]
  listRealms(): GraphNode[]
  async resolveProposal(id: string, resolution: ProposalResolution): Promise<void>
  async runMaintenance(now?: Date): Promise<void> // retry unreflected sessions, build pending rollups, reindex, commit
  async reindexAll(): Promise<void> // full rebuild from folder
}
```

- `endSession` uses `reflectionModel` for reflection. `runMaintenance` also reflects any older unreflected sessions (crash recovery, spec section 10). `readDocumentById` resolves via the index's documents table. `remember` keeps live items in an in-memory map keyed by sessionId, passed as `liveItems` into `applyReflection`.

- [ ] **Step 1: Failing integration test**: open engine in temp dir; start session; append user and assistant lines; `remember` one item; end session with FakeChat scripted to return a reflection JSON containing one new item, one high-confidence attribution to a pre-seeded arc, and one new-arc proposal; assert summary.md exists, graph has item nodes and the unconfirmed edge, proposal pending, search finds the item text, reindexAll then same search still finds it (delete index.db first to prove rebuildability), git log in memory folder has commits.
- [ ] **Step 2: A second test for maintenance**: seed a stale unreflected session and a completed yesterday with sessions but no rollup; open engine; assert reflection retried and daily rollup written.
- [ ] **Step 3: Implement, verify pass, commit** (`feat: MemoryEngine facade with maintenance and rebuildable index`).

---

### Task C1: Config

**Files:**
- Create: `packages/core/src/config.ts`; replace `packages/core/src/index.ts` with re-exports
- Modify: `packages/core/package.json` (add `zod`, `smol-toml`)
- Test: `packages/core/src/config.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CrisisResource { label: string; contact: string }
export const defaultCrisisResources: CrisisResource[] // 988 (US, call or text), findahelpline.com (international)
export interface ReverieConfig {
  memoryDir: string // default: path.join(os.homedir(), '.reverie', 'memory')
  provider: { name: 'openai'; apiKeyEnv?: string; apiKey?: string; baseUrl?: string }
  models: { chat: string; reflection: string; embeddings: string } // defaults: gpt-5, gpt-5-mini, text-embedding-3-small
  safety: { mode: 'companion' | 'firewall'; resources: CrisisResource[] }
}
export function defaultConfigPath(): string // ~/.reverie/config.toml
export async function loadConfig(path?: string): Promise<ReverieConfig> // throws a plain, helpful Error if missing: "No config found. Run: reverie setup"
export async function saveConfig(config: ReverieConfig, path?: string): Promise<void> // 0600 permissions
export function resolveApiKey(config: ReverieConfig): string // apiKey, else process.env[apiKeyEnv], else throw naming both options
```

- zod-validate on load with defaults applied; unknown keys rejected with the key name in the error. Config file may hold the key directly or name an env var; the wizard prefers the env var route and says why (the file lives on disk).

- [ ] **Step 1: Failing tests**: round-trip save/load; defaults applied when sections omitted; missing file error mentions `reverie setup`; resolveApiKey precedence and its failure message; saved file mode is 0600.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: config schema, TOML persistence, key resolution`).

---

### Task C2: Personas and safety modes

**Files:**
- Create: `packages/core/src/personas.ts`
- Test: `packages/core/src/personas.test.ts`

**Interfaces:**
- Produces: `export function buildPersona(mode: 'companion' | 'firewall', resources: CrisisResource[]): string`

- The persona establishes, in plain warm prose (write the actual full text in the implementation, roughly 300-500 words): what reverie is (a private reflective companion with long memory, running on the user's own machine), what it is not (not a therapist, no diagnosis or treatment), the retrieve-before-asserting rule (when conversation touches an arc or past event, search or read the record first instead of answering from gist), how to raise pending proposals naturally near the start, and the crisis stance for the given mode. Companion: stay present, keep listening, respond with warmth, gently and persistently surface the resources and encourage reaching real humans, refuse nothing, shift tone. Firewall: state plainly that this is beyond what it should handle, give the resources immediately and concretely, decline to continue that thread until the topic shifts, stay warm while firm. Resources are rendered as a short list inside the prompt from the config values.
- The mode texts differ only in the crisis section; everything else is shared (test asserts this by construction: shared prefix identical).

- [ ] **Step 1: Failing tests**: both modes contain the resource labels and contacts; companion contains "stay" language and no refusal instruction; firewall contains decline instruction; shared portion identical across modes; no em dash character in either output.
- [ ] **Step 2: Implement (write the real persona prose, honoring AGENTS.md style), verify pass, commit** (`feat: companion and firewall personas`).

---

### Task C3: Context assembly

**Files:**
- Create: `packages/core/src/context.ts`
- Test: `packages/core/src/context.test.ts`

**Interfaces:**
- Consumes: `MemoryEngine.sessionContext()`, `buildPersona`.
- Produces: `export async function assembleSystemPrompt(engine: MemoryEngine, config: ReverieConfig): Promise<string>`

- Layout, in order, with plain section headers: persona; `## Constitution` (full text); `## Realms` (name plus first line each); `## Active arcs` (name, status, last touched); `## Latest daily rollup` (when present); `## Yesterday` (session summaries, when present); `## Pending proposals` (each proposal's summary sentence, with the instruction to weave them in conversationally near the start and record the user's decision with the resolve_proposal tool). Sections with no content are omitted entirely, not left as empty headers.

- [ ] **Step 1: Failing tests** against a seeded temp-dir engine: prompt contains constitution text, arc names, proposal summaries; omits absent sections; persona for the configured mode is at the top.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: session context assembly`).

---

### Task C4: Tools

**Files:**
- Create: `packages/core/src/tools.ts`
- Test: `packages/core/src/tools.test.ts`

**Interfaces:**
- Produces:

```ts
export function toolDefinitions(): ToolDefinition[]
export async function dispatchTool(engine: MemoryEngine, sessionId: string, call: ToolCall): Promise<string>
```

- Tools (names and JSON-schema parameters are the contract; write real descriptions that tell the model when to reach for each):
  - `search_memory {query: string, kinds?: string[], after?: string, before?: string, limit?: number}`
  - `graph_query {kind: 'neighbors'|'items_in_arc'|'arcs_involving_person', nodeId: string}`
  - `read_document {docId: string}`
  - `read_transcript {sessionId: string}`
  - `remember {text: string, kind?: 'observation'|'feeling'|'event'|'intention'}`
  - `list_arcs {}` and `list_realms {}`
  - `resolve_proposal {proposalId: string, resolution: 'accepted'|'rejected'}`
- `dispatchTool` zod-parses `call.arguments`; on parse error or unknown tool it returns a JSON error string (`{"error":"..."}`) rather than throwing (the model should see its mistake and correct). Results are JSON strings; `read_document` returns `{meta, body}`; missing doc returns `{"error":"not found: <id>"}`.

- [ ] **Step 1: Failing tests** against a seeded engine: each tool round-trips through dispatch with realistic arguments; malformed arguments produce the error JSON, not a throw; unknown tool name likewise.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: memory tools and dispatch`).

---

### Task C5: Agent session loop

**Files:**
- Create: `packages/core/src/agent.ts`; finalize `packages/core/src/index.ts` re-exports
- Test: `packages/core/src/agent.test.ts`

**Interfaces:**
- Produces:

```ts
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done' }
export class AgentSession {
  readonly sessionId: string
  static async start(engine: MemoryEngine, config: ReverieConfig, chat: ChatProvider): Promise<AgentSession>
  send(userText: string): AsyncIterable<AgentEvent>
  async end(): Promise<void> // engine.endSession; safe to call once; idempotent second call is a no-op
}
```

- `start` assembles the system prompt once and starts an engine session. `send`: append the user line to the transcript; loop up to 8 rounds: stream from `chat` with `system`, running message history, and `toolDefinitions()`; forward `text` events; on each `tool_call`, emit `{type:'tool', name}`, append the assistant tool-call line and the tool result line to both the transcript and the message history (transcript first, then history), dispatch via `dispatchTool`, and continue the loop; when a round ends with no tool calls, append the assistant text to the transcript and yield `done`. If the provider throws, append nothing further, and rethrow after yielding no partial event (the CLI reports it plainly; the transcript keeps everything already appended).
- Message history within a session lives in memory on the AgentSession; the transcript on disk is the durable record.

- [ ] **Step 1: Failing tests** with a scripted FakeChatProvider: a two-round exchange (first result carries a `search_memory` tool call, second is plain text) yields events `tool, text..., done`, the transcript on disk contains user, assistant tool call, tool result, and final assistant lines in order, and the fake's second request contains the tool result message; a provider error propagates while the transcript retains the user line; `end` reflects (FakeChat reflection script) and a second `end` is a no-op.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: streaming agent loop with tool rounds`).

---

### Task D1: Setup wizard

**Files:**
- Create: `packages/cli/src/setup.ts`
- Test: `packages/cli/src/setup.test.ts`

**Interfaces:**
- Produces: `export async function runSetup(io: { question(prompt: string): Promise<string>; write(text: string): void }, configPath?: string): Promise<void>`
- The wizard asks, in order: provider (only openai for now, enter to accept), API key handling (recommend env var `OPENAI_API_KEY`, allow pasting a key with the honest warning that it will sit in the config file with 0600 permissions), chat model (default gpt-5), reflection model (default gpt-5-mini), embeddings model (default text-embedding-3-small), memory folder (default shown), and the safety mode as an explicit numbered choice with two-sentence honest descriptions of each and no preselected answer (empty input re-asks). Then it writes the config and prints where it wrote it and how to start (`reverie`). Crisis resources get the defaults; the wizard mentions they are editable in the config file.
- `io` is injected so tests can script answers; the CLI entry wires it to `node:readline/promises`.

- [ ] **Step 1: Failing tests**: scripted happy path writes a valid config loadable by `loadConfig` with mode firewall when '2' is chosen; empty safety answer re-asks (script '', then '1'); env-var key route leaves `apiKey` unset and sets `apiKeyEnv`.
- [ ] **Step 2: Implement, verify pass, commit** (`feat: reverie setup wizard`).

---

### Task D2: Chat REPL and subcommands

**Files:**
- Create: `packages/cli/src/chat.ts`; replace `packages/cli/src/index.ts`
- Test: `packages/cli/src/chat.test.ts`

**Interfaces:**
- Produces: `export async function runChat(deps: { engine: MemoryEngine; config: ReverieConfig; chat: ChatProvider; io: ChatIo }): Promise<void>` with `export interface ChatIo { question(prompt: string): Promise<string>; write(text: string): void; onInterrupt(handler: () => void): void }`
- Behavior: banner line stating the memory folder and safety mode; prompt `you> `; stream agent text as it arrives; render tool events dimly as `[searching memory: search_memory]` style notices; `/bye` (or EOF) prints `reflecting on this session...`, calls `session.end()`, prints a one-line confirmation, exits. Ctrl-C mid-response: finish the current write, remind that `/bye` reflects before quitting; second Ctrl-C exits without reflection (the transcript is already safe on disk and maintenance will reflect it next start; say so in one line).
- `index.ts` entry: subcommand `setup` runs the wizard; `reindex` opens the engine and calls `reindexAll` then prints a count line; `reflect` runs `runMaintenance`; default (no args) loads config (printing the helpful error if missing), builds providers via `createChatProvider`/`createEmbeddingProvider` with `resolveApiKey`, opens the engine, runs chat. Provider construction failures and provider-down errors print one plain line each (spec: say it plainly rather than half-working).

- [ ] **Step 1: Failing tests** with scripted io and fakes: a `hello` then `/bye` session streams the fake's text, ends with reflection called (assert summary.md exists), and never throws; tool events render; missing-config path prints the run-setup message.
- [ ] **Step 2: Implement, verify pass, run the real binary once by hand (`pnpm --filter openreverie build && node packages/cli/dist/index.js --help` equivalent smoke), commit** (`feat: terminal chat and maintenance subcommands`).

---

### Task D3: End-to-end harness and honest docs

**Files:**
- Create: `packages/cli/src/e2e.test.ts`, `packages/cli/src/fixtures/first-week.ts` (synthetic scripted conversations and reflection outputs)
- Modify: `README.md` (Status section and a short honest Usage section)
- Test: the e2e file itself

**Interfaces:** consumes only public package APIs (this test is the proof the layering works).

- [ ] **Step 1: Write the e2e test**: simulate three days of sessions against one engine in a temp dir using scripted FakeChat results (conversations plus reflection JSONs that create two arcs via accepted proposals, attribute items, and touch two realms). Between "days", call `runMaintenance` with an advanced `now`. Assert at the end: transcripts intact and append-only (byte compare after a reread); daily rollups exist for the first two days; the constitution file still valid; `search` finds a detail from day one; `graph_query` items_in_arc returns the attributed items; delete `index.db`, `reindexAll`, and re-assert the search result (rebuildability, the spec's core promise).
- [ ] **Step 2: Make it pass (fix whatever it flushes out), run the full suite `pnpm build && pnpm lint && pnpm test`.**
- [ ] **Step 3: Update README Status honestly** (what works: CLI chat with memory, reflection, rollups, proposals, both safety modes; what does not exist yet: web UI, other providers, deployment targets, graph visualization) and add a Usage section (setup, chat, reindex, reflect commands). Verify no em dashes slipped in (`grep -rn '—' README.md` returns nothing). Commit (`feat: end-to-end harness; docs reflect reality`).

---

## Self-Review Notes

- Spec coverage: sections 4 through 11 of the spec map to tasks A1-A3 (spec 8), B1-B11 (spec 5, 6, 10 partially), C1-C5 (spec 7, 9), D1-D3 (spec 4 wizard, 10, 11). Monthly/yearly rollups, web UI, other adapters, deployment, and graph UI are spec non-goals and deliberately absent.
- Type consistency: `ReflectionItem`, `SearchHit`, `GraphNode/GraphEdge`, `SessionContext`, `ToolCall` names are used identically across tasks; `dispatchTool` returns strings; `MemoryEngine` surface in B11 matches what C3-C5 and D2 consume.
- Every code-bearing step names its exact behavior; fixture and prompt content is specified in prose where writing it verbatim here would just duplicate the implementation.
