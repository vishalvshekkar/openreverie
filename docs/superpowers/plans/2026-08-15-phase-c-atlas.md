# Phase C Atlas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release v0.5.0, a full-screen, local-only atlas that lets a person navigate, read, filter, search, and inspect faithful graph history without changing their memory.

**Architecture:** Phase B's server and versioned HTTP contract are fixed inputs. Before Phase C creates `src/atlas/`, it moves Phase B's flat `atlas.ts` module and test into `src/atlas/index.ts` and `index.test.ts`; every import follows the new ESM path. All later Phase C code stays in `packages/web`: Zod validates every HTTP boundary, saved base coordinates stay in versioned browser storage, and a fresh Graphology graph derives temporary rendered coordinates, including realm influence. React renders that projection through Sigma and an accessible parallel DOM view. The memory folder, graph records, and server API remain untouched.

**Tech Stack:** TypeScript with strict project references, Zod 4, React 19, Vite, Vitest, plain CSS, Graphology, Sigma.js, browser `localStorage`, and the existing Phase B JSON HTTP API.

**Spec:** [docs/superpowers/specs/2026-08-15-phase-b-c-web-atlas-design.md](../specs/2026-08-15-phase-b-c-web-atlas-design.md)

## Global Constraints

Every task implicitly includes these requirements.

- Phase B v0.4.0 is complete before Task 1. Do not change `packages/server`, its routes, authentication, graph schemas, request bounds, or error behavior.
- `web` communicates through authenticated same-origin HTTP only. It imports no `core`, `memory`, `providers`, Node, or server implementation module.
- Phase C makes no `POST`, `PUT`, `PATCH`, or `DELETE` request. It never writes a graph assertion, graph retraction, document, transcript, layout coordinate, or any memory-folder file.
- Validate Phase B response envelopes, documents, nodes, edges, and all four graph-event variants with Zod at the browser boundary. A malformed success body, malformed error body, or wrong envelope throws `AtlasApiError('response_invalid', 'Atlas response was invalid.')`; it is never cast into UI state.
- The public graph contract is exact. A node has `id`, `type`, `label`, optional `docId`, and `assertedAt`; an edge has `key`, `type`, `from`, `to`, `confidence`, `confirmed`, optional `sourceSessionId`, and `assertedAt`.
- Nodes of type `person` and `entity` remain selectable without a `docId`. When a person later gains a page, the existing node ID remains its saved-layout identity and the drawer uses the newly supplied `docId`.
- Use Graphology and Sigma.js only inside `packages/web`. Add no rendering dependency to any other package. Zod is the only Phase C dependency addition and is declared directly in `packages/web`.
- Persist only finite base coordinates under one versioned `localStorage` key. New base coordinates are deterministic from node ID, saved base coordinates win, and temporary rendered realm influence is never passed to storage or reconstructed from storage.
- Realm nodes are fixed visual anchors. Influence is a temporary direct-adjacency pull in the newly built Graphology instance. It is neither an inferred relationship nor a graph write.
- The atlas is full-screen, monochrome, readable in light and dark themes, keyboard-operable, focus-visible, and reduced-motion aware. Its semantic parallel DOM list contains exactly the nodes shown in the visual graph.
- Labels become progressively richer as the user zooms in. Far view shows selected and realm labels only, middle view adds matched labels, and close view shows every visible node label.
- The history lens consumes the complete paginated graph-event stream. It preserves assert and retract events, including dangling events, in append sequence and folds a chosen sequence only for display. A history request that is loading or failed has no current history: clear the prior event set, disable the lens, display its loading or safe error state, and offer retry.
- Display document provenance, edge confidence, confirmation state, source session when present, and assertion history. Never infer relationship truth from prose.
- Node is `>=22`; `pnpm`, TypeScript strict mode, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` remain enabled. Keep response data and DOM attributes fully typed.
- Use synthetic fixtures only. Do not add telemetry, analytics, logging of document content, or personal data to tests.
- Never use an em dash in prose, test names, comments, user-facing copy, or commit messages. Keep README and ROADMAP claims true when v0.5.0 lands.

## Exact File Map

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/web/src/atlas.ts` | Move to `atlas/index.ts` | Phase B atlas module relocated before the directory grows. |
| `packages/web/src/atlas.test.ts` | Move to `atlas/index.test.ts` | Existing Phase B atlas coverage relocated without changed behavior. |
| `packages/web/src/App.tsx`, `App.test.tsx` | Modify | ESM imports updated from the flat Phase B atlas module to `atlas/index.js`. |
| `packages/web/package.json`, `pnpm-lock.yaml` | Modify | Declares Zod 4 directly in web and locks only that approved dependency. |
| `packages/web/src/atlas/contracts.ts` | Create | Zod schemas and inferred exact HTTP shapes. |
| `packages/web/src/atlas/api.ts`, `api.test.ts` | Create | Validated, GET-only same-origin Phase B client and invalid-response behavior. |
| `packages/web/src/atlas/positions.ts`, `positions.test.ts` | Create | Finite base-position storage and deterministic base layout only. |
| `packages/web/src/atlas/filters.ts`, `filters.test.ts` | Create | Search, type filtering, and progressive-label decisions. |
| `packages/web/src/atlas/history.ts`, `history.test.ts` | Create | Complete event pagination, repeated-cursor failure, and display-only folding. |
| `packages/web/src/atlas/graph.ts`, `graph.test.ts` | Create | Graphology model with separately named base and rendered coordinates. |
| `packages/web/src/atlas/AtlasCanvas.tsx`, `AtlasCanvas.test.tsx` | Create | Sigma lifecycle, deliberate drag persistence of base coordinates, and labels. |
| `packages/web/src/atlas/AtlasDrawer.tsx`, `AtlasDrawer.test.tsx` | Create | Document reader, provenance, optional-page state, and assertion history. |
| `packages/web/src/atlas/AtlasPage.tsx`, `AtlasPage.test.tsx`, `atlas.css` | Create | Full-screen search/filter navigation, semantic list, and history load states. |
| `packages/web/src/atlas/AtlasHistoryLens.tsx`, `AtlasHistoryLens.test.tsx` | Create | Keyboard time lens, raw event list, loading, safe failure, and retry. |
| `packages/web/src/App.tsx` | Modify | Adds exactly the `/atlas` route after the import migration. |
| `packages/web/src/release.test.ts` | Create | v0.5.0 metadata and documentation truth test. |
| `package.json`, `packages/{cli,core,memory,providers,server,web}/package.json`, `README.md`, `ROADMAP.md` | Modify | v0.5.0 release metadata and honest delivered/deferred capability statements. |

## Shared Interfaces

Task 2 defines the schemas and types below. Later tasks import these names rather than duplicating protocol shapes.

```ts
import { z } from 'zod'

export const atlasNodeSchema = z.strictObject({
  id: z.string(),
  type: z.enum(['realm', 'arc', 'item', 'session', 'person', 'entity']),
  label: z.string(),
  docId: z.string().optional(),
  assertedAt: z.string(),
})
export const atlasEdgeSchema = z.strictObject({
  key: z.string(),
  type: z.enum(['part_of', 'in', 'from', 'involves', 'relates_to']),
  from: z.string(),
  to: z.string(),
  confidence: z.number(),
  confirmed: z.boolean(),
  sourceSessionId: z.string().optional(),
  assertedAt: z.string(),
})
export type AtlasNode = z.infer<typeof atlasNodeSchema>
export type AtlasEdge = z.infer<typeof atlasEdgeSchema>
export type AtlasNodeType = AtlasNode['type']
export type AtlasGraphEvent = z.infer<typeof atlasGraphEventSchema>
export interface AtlasSnapshot { revision: string; nodes: AtlasNode[]; edges: AtlasEdge[] }
export interface AtlasDocument { docId: string; kind: string; title: string; updatedAt: string; readOnly: boolean; body: string }
export interface AtlasEventPage { events: AtlasGraphEvent[]; nextCursor: string | null }
export interface AtlasBasePosition { x: number; y: number }
export type AtlasBasePositions = Record<string, AtlasBasePosition>
```

Task 2 also exposes the only network interface. Its methods issue authenticated GET requests.

```ts
export interface AtlasApi {
  getSnapshot(signal?: AbortSignal): Promise<AtlasSnapshot>
  getDocument(docId: string, signal?: AbortSignal): Promise<AtlasDocument>
  getEventPage(after?: string, signal?: AbortSignal): Promise<AtlasEventPage>
}

export class AtlasApiError extends Error {
  constructor(readonly code: string, message: string)
}
```

Task 5 exposes a separate coordinate boundary. `baseX` and `baseY` are the only values a drag may send to Task 6. `x` and `y` are render-only and may include influence.

```ts
export interface AtlasNodeAttributes {
  id: string; label: string; type: AtlasNodeType
  baseX: number; baseY: number
  x: number; y: number
  size: number; color: string; fixed: boolean; zIndex: number
}
```

## Task Order and Rationale

| Task | Deliverable |
| --- | --- |
| 1 | Safe migration of Phase B's flat atlas module before `atlas/` exists. |
| 2 | Zod-validated read-only HTTP boundary and exact shared contracts. |
| 3 | Deterministic browser-local base positions and pure navigation primitives. |
| 4 | Complete faithful event pagination and display-only history folding. |
| 5 | Ephemeral Graphology projection and Sigma canvas, with base/rendered-coordinate separation. |
| 6 | Full-screen reader, search/filter controls, semantic navigation, and browser-local drag storage. |
| 7 | History time lens integration with loading, repeated-cursor failure, error, and retry semantics. |
| 8 | v0.5.0 metadata, documentation, and final acceptance. |

Each task has an independently reviewable outcome. In particular, no canvas work starts before the protocol, layout persistence, and history pagination boundaries are tested.

---

### Task 1: migrate the Phase B atlas module before adding the atlas directory

**Files:**

- Move: `packages/web/src/atlas.ts` to `packages/web/src/atlas/index.ts`
- Move: `packages/web/src/atlas.test.ts` to `packages/web/src/atlas/index.test.ts`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/App.test.tsx`

**Interfaces:**

- Consumes: the completed Phase B `Atlas`, `buildAtlasModel`, and their existing tests.
- Produces: the same Phase B exports at `./atlas/index.js`, leaving `packages/web/src/atlas/` available for later focused modules.

- [ ] **Step 1: Add the migration regression assertion before moving files**

In the existing `packages/web/src/atlas.test.ts`, add a narrow export-consumption test that uses the public component and model through the module import already used by Phase B. Keep the existing Phase B fixture and assert both names are defined:

```ts
import { Atlas, buildAtlasModel } from './atlas.js'

it('keeps the Phase B atlas public exports during the module migration', () => {
  expect(Atlas).toBeDefined()
  expect(buildAtlasModel).toBeDefined()
})
```

- [ ] **Step 2: Run the Phase B atlas regression before the move**

Run:

```bash
pnpm vitest run packages/web/src/atlas.test.ts packages/web/src/App.test.tsx
```

Expected: PASS on the completed Phase B layout, proving the migration has a behavior baseline.

- [ ] **Step 3: Move both Phase B files and update every ESM import**

Run these exact moves, then update the Phase B imports in `App.tsx`, `App.test.tsx`, and the moved test from `./atlas.js` to `./atlas/index.js` (or the corresponding relative `./atlas/index.js` path from its new directory):

```bash
git mv packages/web/src/atlas.ts packages/web/src/atlas/index.ts
git mv packages/web/src/atlas.test.ts packages/web/src/atlas/index.test.ts
```

The moved test imports its sibling with `from './index.js'`. `App.tsx` and `App.test.tsx` import the public Phase B component with `from './atlas/index.js'`. Search all web source before proceeding; the command must report no import ending in the obsolete flat-module path:

```bash
rg -n "from ['\"](?:\./|\.\./)*atlas\.js['\"]|import\(['\"](?:\./|\.\./)*atlas\.js['\"]\)" packages/web/src
```

Expected: no matches. Do not create any other `atlas.ts` compatibility shim, because it would recreate the file-versus-directory collision.

- [ ] **Step 4: Rerun the relocated regression tests**

Run:

```bash
pnpm vitest run packages/web/src/atlas/index.test.ts packages/web/src/App.test.tsx
pnpm --filter @openreverie/web build
```

Expected: PASS. The app and test compilation resolve only `atlas/index.js`.

- [ ] **Step 5: Independent reviewer gate**

The reviewer runs the two commands above plus:

```bash
pnpm test
pnpm build
pnpm lint
```

Falsify the migration assertion by temporarily changing `App.tsx` back to `from './atlas.js'`; the web build must fail. Restore `from './atlas/index.js'`, rerun the targeted tests and all three full commands.

- [ ] **Step 6: Commit the reviewed migration**

```bash
git add packages/web/src/atlas/index.ts packages/web/src/atlas/index.test.ts packages/web/src/App.tsx packages/web/src/App.test.tsx
git commit -m "Move Phase B atlas into its module directory"
```

### Task 2: validate the Phase B atlas HTTP contract at the browser boundary

**Files:**

- Modify: `packages/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/web/src/atlas/contracts.ts`
- Create: `packages/web/src/atlas/api.ts`
- Create: `packages/web/src/atlas/api.test.ts`

**Interfaces:**

- Consumes: only Phase B `GET /api/v1/graph/snapshot`, `GET /api/v1/graph/events`, and `GET /api/v1/documents/:docId` responses.
- Produces: `AtlasApi`, `AtlasApiError`, all schemas and types in Shared Interfaces, and `createAtlasApi(fetchImpl)` for Tasks 4, 6, and 7.

- [ ] **Step 1: Add failing schema-boundary tests**

Use a fake fetch and this response helper in `api.test.ts`:

```ts
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
```

Cover an unpaged entity, a document, and all four event variants in valid envelopes. Then prove malformed values never cross the client boundary:

```ts
it('rejects a snapshot whose node omits assertedAt', async () => {
  const api = createAtlasApi(vi.fn().mockResolvedValue(jsonResponse({
    data: { revision: 'r1', nodes: [{ id: 'person:ada', type: 'person', label: 'Ada' }], edges: [] },
    meta: { nextCursor: null },
  })))

  await expect(api.getSnapshot()).rejects.toMatchObject({
    code: 'response_invalid', message: 'Atlas response was invalid.',
  })
})

it('rejects an invalid non-OK error envelope instead of exposing response internals', async () => {
  const api = createAtlasApi(vi.fn().mockResolvedValue(jsonResponse({ error: 'database detail' }, 500)))
  await expect(api.getSnapshot()).rejects.toMatchObject({ code: 'response_invalid' })
})
```

Also assert that a valid 404 error envelope yields its public `code` and `message`, document IDs are URI encoded, and every call uses exactly `{ credentials: 'same-origin' }` with no method, body, token, header, or mutation.

- [ ] **Step 2: Run the API tests and observe the failure**

Run:

```bash
pnpm vitest run packages/web/src/atlas/api.test.ts
```

Expected: FAIL because `contracts.js` and `api.js` do not exist.

- [ ] **Step 3: Add Zod and implement the exact response schemas**

Add `"zod": "^4.0.0"` to `packages/web/package.json` `dependencies`, then run:

```bash
pnpm install --lockfile-only
```

In `contracts.ts`, implement `atlasNodeSchema` and `atlasEdgeSchema` exactly as Shared Interfaces shows. Add strict schemas for documents, success envelopes, errors, and the complete discriminated event union:

```ts
export const atlasGraphEventSchema = z.union([
  z.strictObject({ sequence: z.number().int().positive(), op: z.literal('assert'), kind: z.literal('node'), assertedAt: z.string(), node: atlasNodeSchema }),
  z.strictObject({ sequence: z.number().int().positive(), op: z.literal('assert'), kind: z.literal('edge'), assertedAt: z.string(), edge: atlasEdgeSchema }),
  z.strictObject({ sequence: z.number().int().positive(), op: z.literal('retract'), kind: z.literal('node'), assertedAt: z.string(), nodeId: z.string() }),
  z.strictObject({ sequence: z.number().int().positive(), op: z.literal('retract'), kind: z.literal('edge'), assertedAt: z.string(), edgeKey: z.string() }),
])
export const atlasErrorSchema = z.strictObject({ schemaVersion: z.literal('1'), code: z.string(), message: z.string() })
export function atlasEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ data, meta: z.strictObject({ nextCursor: z.string().nullable() }) })
}
```

Define `atlasSnapshotSchema` as an envelope around strict `{ revision, nodes, edges }`, `atlasDocumentSchema` as an envelope around strict document data, and `atlasEventsSchema` as an envelope around `z.array(atlasGraphEventSchema)`. `AtlasDocument`, `AtlasSnapshot`, and `AtlasEventPage` must be inferred or constructed from parsed values, not `as` casts of unknown response JSON.

- [ ] **Step 4: Implement the GET-only validated client**

Create `api.ts` with one parser used by all three endpoint methods:

```ts
async function readJson(response: Response): Promise<unknown> {
  try { return await response.json() }
  catch { throw new AtlasApiError('response_invalid', 'Atlas response was invalid.') }
}

function invalidResponse(): AtlasApiError {
  return new AtlasApiError('response_invalid', 'Atlas response was invalid.')
}
```

`getEnvelope` fetches with `{ credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) }`. Parse unknown JSON once. If `response.ok` is false, `atlasErrorSchema.safeParse(body)` must succeed before throwing `new AtlasApiError(error.code, error.message)`; otherwise throw `invalidResponse()`. If it is true, call the endpoint's Zod envelope schema and throw `invalidResponse()` on failure. Return only parsed data.

`getSnapshot` uses `/api/v1/graph/snapshot`; `getDocument` uses `/api/v1/documents/${encodeURIComponent(docId)}`; and `getEventPage` uses `/api/v1/graph/events?limit=2000` or `?after=${encodeURIComponent(after)}&limit=2000`. Convert its parsed envelope to `{ events: data, nextCursor: meta.nextCursor }`. No `fetch` call may have a request method or body.

- [ ] **Step 5: Run the targeted API tests**

Run:

```bash
pnpm vitest run packages/web/src/atlas/api.test.ts
```

Expected: PASS, including valid optional `docId`, all event variants, bad success envelope, bad error envelope, valid public error, URI encoding, and GET-only request assertions.

- [ ] **Step 6: Independent reviewer gate**

The reviewer runs:

```bash
pnpm test
pnpm build
pnpm lint
```

Falsify `rejects a snapshot whose node omits assertedAt` by temporarily replacing the snapshot `safeParse` branch with `return body as AtlasSnapshot`; the targeted test must fail. Restore Zod parsing, rerun the targeted test and the three full commands.

- [ ] **Step 7: Commit the reviewed API boundary**

```bash
git add packages/web/package.json pnpm-lock.yaml packages/web/src/atlas/contracts.ts packages/web/src/atlas/api.ts packages/web/src/atlas/api.test.ts
git commit -m "Validate atlas API responses in the browser"
```

### Task 3: persist only finite base positions and create navigation primitives

**Files:**

- Create: `packages/web/src/atlas/positions.ts`
- Create: `packages/web/src/atlas/positions.test.ts`
- Create: `packages/web/src/atlas/filters.ts`
- Create: `packages/web/src/atlas/filters.test.ts`

**Interfaces:**

- Consumes: `AtlasNode` and `AtlasNodeType` from Task 2.
- Produces: `ATLAS_BASE_POSITION_STORAGE_KEY`, `seedAtlasBasePosition`, `loadAtlasBasePositions`, `saveAtlasBasePositions`, `mergeAtlasBasePositions`, `filterAtlasNodes`, and `labelModeForCameraRatio` for Tasks 5 through 7.

- [ ] **Step 1: Add failing base-position and filter tests**

Use synthetic nodes with a person that later gains a `docId`. Assert saved base coordinates survive both snapshots and stale node IDs are discarded. Include storage boundary tests:

```ts
it('serializes only finite base coordinates', () => {
  const setItem = vi.fn()
  saveAtlasBasePositions({ setItem }, {
    'person:ada': { x: 17, y: -8 },
    invalid: { x: Number.NaN, y: Infinity },
  })
  expect(JSON.parse(setItem.mock.calls[0]?.[1] as string)).toEqual({ 'person:ada': { x: 17, y: -8 } })
})

it('drops corrupt browser storage instead of retaining rendered values', () => {
  expect(loadAtlasBasePositions({ getItem: () => '{"person:ada":{"x":0,"y":"bad"}}' })).toEqual({})
})
```

In `filters.test.ts`, assert case-insensitive query plus type filtering and the three fixed thresholds: ratio `2` is `anchor-or-selected`, `1` is `matched-or-selected`, and `0.5` is `all-visible`.

- [ ] **Step 2: Run the targeted tests and observe the failure**

Run:

```bash
pnpm vitest run packages/web/src/atlas/positions.test.ts packages/web/src/atlas/filters.test.ts
```

Expected: FAIL with module-not-found errors for `positions.js` and `filters.js`.

- [ ] **Step 3: Implement base-only local storage**

Create `positions.ts`:

```ts
export const ATLAS_BASE_POSITION_STORAGE_KEY = 'openreverie.atlas.base-positions.v1'

export function mergeAtlasBasePositions(nodes: readonly AtlasNode[], saved: AtlasBasePositions): AtlasBasePositions {
  return Object.fromEntries(nodes.map((node) => [node.id, saved[node.id] ?? seedAtlasBasePosition(node.id)]))
}
```

Use the deterministic FNV-style seed from the former plan, renamed `seedAtlasBasePosition`. `loadAtlasBasePositions` accepts only an object whose entries are objects with finite numeric `x` and `y`; any parse error or invalid entry makes the whole read `{}`. `saveAtlasBasePositions` filters every non-finite entry before serializing. The module must not export a function named `saveAtlasPositions`, must not know Graphology attributes, and must not accept rendered `x`/`y` from Task 5.

Create `filters.ts` with `filterAtlasNodes(nodes, query, allowedTypes)` and `labelModeForCameraRatio(ratio)` using the thresholds tested in Step 1. Filtered nodes are the sole source for both visual and semantic visibility later.

- [ ] **Step 4: Run the targeted tests**

Run:

```bash
pnpm vitest run packages/web/src/atlas/positions.test.ts packages/web/src/atlas/filters.test.ts
```

Expected: PASS.

- [ ] **Step 5: Independent reviewer gate**

The reviewer runs:

```bash
pnpm test
pnpm build
pnpm lint
```

Falsify `serializes only finite base coordinates` by removing the finite-number filter in `saveAtlasBasePositions`; the targeted test must fail because JSON converts non-finite numbers. Restore the filter, rerun targeted and full verification.

- [ ] **Step 6: Commit the reviewed local-state primitives**

```bash
git add packages/web/src/atlas/positions.ts packages/web/src/atlas/positions.test.ts packages/web/src/atlas/filters.ts packages/web/src/atlas/filters.test.ts
git commit -m "Add atlas base positions and navigation filters"
```

### Task 4: load complete faithful event history and fold it only for display

**Files:**

- Create: `packages/web/src/atlas/history.ts`
- Create: `packages/web/src/atlas/history.test.ts`

**Interfaces:**

- Consumes: `AtlasApi`, `AtlasApiError`, `AtlasEdge`, `AtlasGraphEvent`, `AtlasNode`, and `AtlasSnapshot` from Task 2.
- Produces: `AtlasHistoryError`, `readAllAtlasEvents(api, signal?)`, and `foldAtlasEvents(events, throughSequence)` for Task 7.

- [ ] **Step 1: Add failing pagination and folding tests**

Use a fake `AtlasApi` with two pages. Assert the second request receives the first opaque cursor, resulting events retain append sequence, and a dangling retraction remains in the raw result while the folded graph omits it. Add a repeated-cursor case:

```ts
it('rejects a repeated next cursor instead of looping', async () => {
  const getEventPage = vi.fn()
    .mockResolvedValueOnce({ events: [], nextCursor: 'again' })
    .mockResolvedValueOnce({ events: [], nextCursor: 'again' })
    .mockResolvedValueOnce({ events: [], nextCursor: null })
  const api: AtlasApi = {
    getSnapshot: vi.fn(), getDocument: vi.fn(),
    getEventPage,
  }
  await expect(readAllAtlasEvents(api)).rejects.toMatchObject({ code: 'cursor_repeated' })
  expect(getEventPage).toHaveBeenCalledTimes(2)
})
```

Also assert an event page whose sequence is not strictly greater than the previous event is rejected as `AtlasHistoryError('response_invalid', 'Atlas history response was invalid.')`, because pagination must not turn a malformed sequence into a false timeline.

- [ ] **Step 2: Run the history tests and observe the failure**

Run:

```bash
pnpm vitest run packages/web/src/atlas/history.test.ts
```

Expected: FAIL with a module-not-found error for `history.js`.

- [ ] **Step 3: Implement finite pagination and display-only folding**

Create `history.ts`:

```ts
export class AtlasHistoryError extends Error {
  constructor(readonly code: 'cursor_repeated' | 'response_invalid', message: string) {
    super(message)
    this.name = 'AtlasHistoryError'
  }
}

export async function readAllAtlasEvents(api: AtlasApi, signal?: AbortSignal): Promise<AtlasGraphEvent[]> {
  const events: AtlasGraphEvent[] = []
  const seenNextCursors = new Set<string>()
  let after: string | undefined
  do {
    const page = await api.getEventPage(after, signal)
    for (const event of page.events) {
      if (events.length > 0 && event.sequence <= events[events.length - 1]!.sequence) {
        throw new AtlasHistoryError('response_invalid', 'Atlas history response was invalid.')
      }
      events.push(event)
    }
    if (page.nextCursor !== null && seenNextCursors.has(page.nextCursor)) {
      throw new AtlasHistoryError('cursor_repeated', 'Unable to load graph history.')
    }
    if (page.nextCursor !== null) seenNextCursors.add(page.nextCursor)
    after = page.nextCursor ?? undefined
  } while (after !== undefined)
  return events
}
```

Implement `foldAtlasEvents(events, throughSequence)` with local node and edge maps. Apply all four event variants through the selected sequence, sort nodes by `assertedAt`, `id` and edges by `assertedAt`, `key`, and omit only dangling edges from the returned display snapshot. Never mutate `events`, make a fetch call, or write storage.

- [ ] **Step 4: Run the targeted history tests**

Run:

```bash
pnpm vitest run packages/web/src/atlas/history.test.ts
```

Expected: PASS, including two pages, repeated cursor rejection, malformed sequence rejection, faithful dangling raw event, and folded display output.

- [ ] **Step 5: Independent reviewer gate**

The reviewer runs:

```bash
pnpm test
pnpm build
pnpm lint
```

Falsify `rejects a repeated next cursor instead of looping` by deleting the `seenNextCursors.has` branch. The test fixture's third page then lets the function return, and its two-call assertion must fail after the unwanted third request. Restore the branch, rerun targeted and full verification.

- [ ] **Step 6: Commit the reviewed history model**

```bash
git add packages/web/src/atlas/history.ts packages/web/src/atlas/history.test.ts
git commit -m "Add faithful atlas history pagination"
```

### Task 5: build an ephemeral influenced graph and a base-coordinate canvas adapter

**Files:**

- Create: `packages/web/src/atlas/graph.ts`
- Create: `packages/web/src/atlas/graph.test.ts`
- Create: `packages/web/src/atlas/AtlasCanvas.tsx`
- Create: `packages/web/src/atlas/AtlasCanvas.test.tsx`

**Interfaces:**

- Consumes: `AtlasSnapshot` from Task 2 and `AtlasBasePositions` from Task 3. It declares `visibleNodeIds` and `matchedNodeIds` inputs, which Task 6 supplies from its filter state.
- Produces: `buildAtlasGraph`, `applyTemporaryRealmInfluence`, and `AtlasCanvas` with props `{ snapshot, basePositions, visibleNodeIds, matchedNodeIds, selectedNodeId, onSelectNode, onBasePositionsChange }` for Task 6.

- [ ] **Step 1: Add failing base-versus-rendered tests**

In `graph.test.ts`, use a realm at `{ x: 0, y: 0 }` and a directly connected person whose base coordinate is `{ x: 100, y: 0 }`. Assert all of the following in one test:

```ts
expect(graph.getNodeAttribute('realm:work', 'fixed')).toBe(true)
expect(graph.getNodeAttribute('person:ada', 'baseX')).toBe(100)
expect(graph.getNodeAttribute('person:ada', 'x')).toBeLessThan(100)
expect(basePositions['person:ada']).toEqual({ x: 100, y: 0 })
```

Build the graph a second time from the same `basePositions` and assert its person starts from the same `baseX: 100`, even though the first graph's rendered `x` was influenced. Add a direct call to `applyTemporaryRealmInfluence` twice and assert the second call does not alter `baseX` or `baseY`.

In `AtlasCanvas.test.tsx`, mock Sigma and its mouse captor. Simulate a non-realm drag to base `{ x: 25, y: 30 }`. Before mouseup, make the mock graph return deliberately divergent attributes `{ baseX: 25, baseY: 30, x: 21, y: 25 }`; assert the callback receives `{ 'person:ada': { x: 25, y: 30 } }`. This proves mouseup reads base values rather than rendered influence values. Simulate a renderer refresh without a drag and assert the callback has not run.

- [ ] **Step 2: Run the canvas and graph tests and observe the failure**

Run:

```bash
pnpm vitest run packages/web/src/atlas/graph.test.ts packages/web/src/atlas/AtlasCanvas.test.tsx
```

Expected: FAIL with module-not-found errors for `graph.js` and `AtlasCanvas.js`.

- [ ] **Step 3: Implement the base/rendered Graphology boundary**

Use `MultiUndirectedGraph` and add only visible nodes and edges with two visible ends. Each added node receives immutable-for-influence base attributes and initially matching render attributes:

```ts
const base = basePositions[node.id]
if (base === undefined) throw new Error(`Missing atlas base position for ${node.id}.`)
graph.addNode(node.id, {
  id: node.id, label: node.label, type: node.type,
  baseX: base.x, baseY: base.y, x: base.x, y: base.y,
  size: node.type === 'realm' ? 18 : 8,
  color: node.type === 'realm' ? '#111111' : '#737373',
  fixed: node.type === 'realm', zIndex: node.type === 'realm' ? 2 : 1,
})
```

`applyTemporaryRealmInfluence` skips realms, averages only direct realm-neighbor rendered coordinates, and changes only node `x` and `y` by a 16 percent pull. It must never call `setNodeAttribute` for `baseX` or `baseY`, mutate `basePositions`, or export Graphology positions to storage. Rebuilding the graph always resets rendered coordinates from base coordinates before this one influence pass.

- [ ] **Step 4: Implement the Sigma lifecycle and drag adapter**

Create one `div` ref, instantiate `new Sigma(graph, container, settings)` in an effect, and kill it in cleanup. Rebuild only when snapshot revision, visible IDs, or base positions change. The canvas is `aria-hidden="true"` and not focusable because Task 6 provides the keyboard equivalent.

On `downNode`, prevent dragging realms. On mouse move for another node, calculate the graph point and set both `baseX/baseY` and rendered `x/y` to that deliberate pointer location. On mouseup, persist only the base fields:

```ts
const attributes = graph.getNodeAttributes(draggedNode)
onBasePositionsChange({
  ...basePositions,
  [draggedNode]: { x: attributes.baseX, y: attributes.baseY },
})
```

There is no callback from `applyTemporaryRealmInfluence`, no effect that observes graph `x/y`, and no call to `onBasePositionsChange` unless an eligible node drag completes. Use `labelModeForCameraRatio` on camera updates, preserve full labels in the graph model, and set only the current render's hidden labels to `''`. Realms and the selected node are always labeled, matches join at middle range, and all visible nodes join at close range. Respect reduced motion for camera changes.

- [ ] **Step 5: Run the targeted visual-model tests**

Run:

```bash
pnpm vitest run packages/web/src/atlas/graph.test.ts packages/web/src/atlas/AtlasCanvas.test.tsx
```

Expected: PASS, including filtered-edge omission, non-realm `fixed: false`, drag callback, and the no-drag persistence assertion.

- [ ] **Step 6: Independent reviewer gate**

The reviewer runs:

```bash
pnpm test
pnpm build
pnpm lint
```

Falsify `starts a rebuilt graph from base coordinates after realm influence` by changing the graph builder to use prior rendered `x` for `baseX`. The targeted test must fail. Separately falsify the storage boundary by changing mouseup to persist `attributes.x` and `attributes.y`; the drag test must fail when the fixture gives those rendered values a different influence-adjusted value. Restore both base-field branches, rerun targeted and full verification.

- [ ] **Step 7: Commit the reviewed graph and canvas boundary**

```bash
git add packages/web/src/atlas/graph.ts packages/web/src/atlas/graph.test.ts packages/web/src/atlas/AtlasCanvas.tsx packages/web/src/atlas/AtlasCanvas.test.tsx
git commit -m "Render atlas realm influence without persisting it"
```

### Task 6: compose the full-screen reader and accessible atlas navigation

**Files:**

- Create: `packages/web/src/atlas/AtlasDrawer.tsx`
- Create: `packages/web/src/atlas/AtlasDrawer.test.tsx`
- Create: `packages/web/src/atlas/AtlasPage.tsx`
- Create: `packages/web/src/atlas/AtlasPage.test.tsx`
- Create: `packages/web/src/atlas/atlas.css`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**

- Consumes: `AtlasApi` from Task 2, base-position functions and filters from Task 3, and `AtlasCanvas` from Task 5.
- Produces: `/atlas`, `AtlasPage`, `AtlasDrawer`, exact canvas/list parity, and the sole `saveAtlasBasePositions` call site. Task 7 adds history props without changing these contracts' persistence boundary.

- [ ] **Step 1: Add failing reader and navigation tests**

In `AtlasDrawer.test.tsx`, select an unpaged entity and assert it shows `This graph node has no maintained page.` without a document request. Select a later-promoted person with `docId: 'doc:ada'` and assert exactly `/api/v1/documents/doc%3Aada` is requested and its body is shown as text. Test a document 404 as `This page is no longer available.` while retaining node metadata.

In `AtlasPage.test.tsx`, use a snapshot with an arc and person. Assert search and a type checkbox remove a node from both `AtlasCanvas` props and `<ul role="listbox" aria-label="Atlas nodes">`; ArrowDown moves selection and focus; filtering the selected node clears selection and closes the drawer. Assert a canvas completed drag calls storage with the base callback value.

- [ ] **Step 2: Run the reader and navigation tests and observe the failure**

Run:

```bash
pnpm vitest run packages/web/src/atlas/AtlasDrawer.test.tsx packages/web/src/atlas/AtlasPage.test.tsx
```

Expected: FAIL with module-not-found errors for `AtlasDrawer.js` and `AtlasPage.js`.

- [ ] **Step 3: Implement the document drawer**

`AtlasDrawer` receives `{ node, edges, api, events, onClose }`. Fetch only when `node?.docId` exists and abort in effect cleanup. A public 404 shows `This page is no longer available.`; other `AtlasApiError` messages are shown unchanged; no document body is fabricated. Render type, asserted time, optional page state, each incident edge's type, adjacent ID, rounded confidence, confirmation, optional source session, and asserted time. Render raw matching assertion events under `<h3>Assertion history</h3>`.

- [ ] **Step 4: Implement full-screen search, list parity, and base-only persistence**

`AtlasPage` loads a snapshot on mount and explicit `Refresh atlas`. It loads `loadAtlasBasePositions(localStorage)`, derives `mergeAtlasBasePositions(snapshot.nodes, saved)`, and passes those values as `basePositions` to the canvas. Its one canvas callback is:

```ts
const onBasePositionsChange = (next: AtlasBasePositions) => {
  setBasePositions(next)
  saveAtlasBasePositions(localStorage, next)
}
```

No other module or effect calls `saveAtlasBasePositions`. Do not pass a rendered Graphology graph or rendered `x/y` into this callback.

Use a labelled search input, native labelled checkboxes for all six types, an empty graph state, an empty-filter state, and a type legend. Visible nodes derive only from `filterAtlasNodes`; `visibleNodeIds` passes to the canvas and the same array fills the semantic list. Each list item is a `<button role="option">`, `aria-selected` follows the selected ID, click and Enter select, and ArrowUp/ArrowDown select and focus an adjacent visible node.

Add the exact `/atlas` branch to `App.tsx` and an `<a href="/atlas">Atlas</a>` navigation entry without changing any existing Phase B branch. Create monochrome light/dark, fixed full-screen, focus-visible, responsive-control, and reduced-motion CSS. The drawer remains an overlay, not a route.

- [ ] **Step 5: Run the targeted reader and navigation tests**

Run:

```bash
pnpm vitest run packages/web/src/atlas/AtlasDrawer.test.tsx packages/web/src/atlas/AtlasPage.test.tsx
```

Expected: PASS, including no-page selection, promotion document read, document 404, ArrowDown, filter-removes-selection, canvas/list parity, and base-only storage callback.

- [ ] **Step 6: Independent reviewer gate**

The reviewer runs:

```bash
pnpm test
pnpm build
pnpm lint
```

Falsify the parity test by passing all snapshot IDs to `AtlasCanvas` instead of `visibleNodeIds`; the targeted test must fail. Falsify base-only persistence by changing the page callback to save a fixture's influenced rendered coordinates; its storage assertion must fail. Restore both branches, rerun targeted and full verification.

- [ ] **Step 7: Commit the reviewed reader and navigation surface**

```bash
git add packages/web/src/App.tsx packages/web/src/atlas/AtlasDrawer.tsx packages/web/src/atlas/AtlasDrawer.test.tsx packages/web/src/atlas/AtlasPage.tsx packages/web/src/atlas/AtlasPage.test.tsx packages/web/src/atlas/atlas.css
git commit -m "Add full-screen atlas navigation and reader"
```

### Task 7: add a recoverable faithful history time lens

**Files:**

- Create: `packages/web/src/atlas/AtlasHistoryLens.tsx`
- Create: `packages/web/src/atlas/AtlasHistoryLens.test.tsx`
- Modify: `packages/web/src/atlas/AtlasPage.tsx`
- Modify: `packages/web/src/atlas/AtlasPage.test.tsx`
- Modify: `packages/web/src/atlas/AtlasDrawer.tsx`
- Modify: `packages/web/src/atlas/AtlasDrawer.test.tsx`
- Modify: `packages/web/src/atlas/atlas.css`

**Interfaces:**

- Consumes: `readAllAtlasEvents`, `foldAtlasEvents`, and `AtlasHistoryError` from Task 4, `AtlasApiError` from Task 2, plus Task 6 page and drawer interfaces.
- Produces: `AtlasHistoryLens` and a page history state whose only `ready` branch has events, a sequence, and a selectable historical graph.

- [ ] **Step 1: Add failing history loading, failure, and retry tests**

In `AtlasHistoryLens.test.tsx`, test raw append order, range `0` through latest sequence, `Before the first assertion`, dangling retraction visibility, and the Latest button. Add explicit states:

```tsx
render(<AtlasHistoryLens state={{ kind: 'loading' }} onRetry={vi.fn()} onSequenceChange={vi.fn()} />)
expect(screen.getByText('Loading graph history…')).toBeVisible()
expect(screen.queryByRole('slider')).toBeNull()

const retry = vi.fn()
render(<AtlasHistoryLens state={{ kind: 'error', message: 'Unable to load graph history.' }} onRetry={retry} onSequenceChange={vi.fn()} />)
expect(screen.getByRole('button', { name: 'Retry history' })).toBeEnabled()
expect(screen.queryByText('Through assertion 3')).toBeNull()

it('hides unknown history failure details', async () => {
  const getEventPage = vi.fn().mockRejectedValue(new Error('database password leaked'))
  render(<AtlasPage api={{ ...api, getEventPage }} />)
  await waitFor(() => expect(screen.getByText('Unable to load graph history.')).toBeVisible())
  expect(screen.queryByText('database password leaked')).toBeNull()
})
```

In `AtlasPage.test.tsx`, start with a successful history load, click `Refresh atlas` or `Retry history` to begin a new history load, then reject its `getEventPage` with `AtlasHistoryError('cursor_repeated', 'Unable to load graph history.')`. Assert the previous raw event text, Latest button, slider, and historical canvas state are gone, the safe error and retry button are visible, and the current snapshot remains a normal current atlas view. Click retry, resolve a fresh page, and assert the controls and raw event return only from that fresh successful result. Also assert a repeated-cursor API never makes the UI call a third page.

Also test lifecycle wiring in `AtlasPage.test.tsx`: after mount, assert `loadHistory` calls `getEventPage` immediately, and clicking `Refresh atlas` starts a new history request. When refresh begins, assert the prior events, history error, and loading state are cleared before the new result resolves. Abort the prior request before starting the replacement, and assert an aborted prior request cannot overwrite the replacement result. On unmount, abort the in-flight snapshot and history requests and ignore their late resolutions or rejections; the test must not report an unhandled rejection.

- [ ] **Step 2: Run the history UI tests and observe the failure**

Run:

```bash
pnpm vitest run packages/web/src/atlas/AtlasHistoryLens.test.tsx packages/web/src/atlas/AtlasPage.test.tsx packages/web/src/atlas/AtlasDrawer.test.tsx
```

Expected: FAIL with a module-not-found error for `AtlasHistoryLens.js` and missing history-state behavior.

- [ ] **Step 3: Implement explicit history states and the keyboard lens**

Define the discriminated state in `AtlasPage.tsx` and reset it before every history request:

```ts
type AtlasHistoryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; events: AtlasGraphEvent[]; sequence: number }

function safeHistoryMessage(error: unknown): string {
  if (error instanceof AtlasHistoryError || error instanceof AtlasApiError) return error.message
  return 'Unable to load graph history.'
}

async function loadHistory(signal?: AbortSignal) {
  setHistory({ kind: 'loading' })
  try {
    const events = await readAllAtlasEvents(api, signal)
    setHistory({ kind: 'ready', events, sequence: events.at(-1)?.sequence ?? 0 })
  } catch (error) {
    if (signal?.aborted) return
    setHistory({ kind: 'error', message: safeHistoryMessage(error) })
  }
}

Keep the active history `AbortController` in a ref. `loadHistory` must abort and replace the prior controller before setting `{ kind: 'loading' }`, so every mount, `Refresh atlas`, and `Retry history` request starts with no stale events or error. Call `loadHistory()` from the mount effect and from the refresh handler, and abort that controller in the effect cleanup. Use the same abort-and-replace pattern for the snapshot request. The mount effect cleanup also marks the page inactive; every async continuation checks `signal.aborted` or that inactive flag before setting state. An unknown thrown value, including an ordinary `Error` with a server or transport detail, must therefore display only `Unable to load graph history.`. Only the known public messages from `AtlasHistoryError` and `AtlasApiError` may reach the UI.
```

The page renders a time lens only for `ready`; therefore no failed or stale events are labeled current. In `loading`, render only `Loading graph history…`; in `error`, render the safe message and `<button type="button">Retry history</button>`. Retry starts a fresh request, not a reuse of old events. The current snapshot remains visible while history is unavailable, but the page must not pass a folded stale snapshot to canvas, list, or drawer.

`AtlasHistoryLens` receives `{ state, onRetry, onSequenceChange }`. In its ready branch use a labelled native range input and `formatAtlasEvent` for all four variants. It lists raw events in their received append order and includes each event's `assertedAt` as `<time dateTime={event.assertedAt}>`. The history rail precedes the drawer in tab order and is a native expandable `<details>` on narrow screens.

- [ ] **Step 4: Integrate historical display and provenance safely**

For ready state only, calculate `displaySnapshot` as the latest snapshot when `sequence === latest`, otherwise `foldAtlasEvents(events, sequence)`. Feed `displaySnapshot` to canvas, filters, and the semantic list. Keep the raw ready events for the lens and drawer. If the chosen sequence hides the selection, clear it and close the drawer. If history is idle, loading, or error, use the current Phase B snapshot for visual navigation and pass `[]` to drawer assertion history.

When the raw ready event set changes, verify that its first and last sequence define the slider range. Do not write the selected sequence, events, folded snapshot, or any coordinate to the memory folder or `localStorage`.

- [ ] **Step 5: Run the targeted history UI tests**

Run:

```bash
pnpm vitest run packages/web/src/atlas/AtlasHistoryLens.test.tsx packages/web/src/atlas/AtlasPage.test.tsx packages/web/src/atlas/AtlasDrawer.test.tsx
```

Expected: PASS, including loading, repeated-cursor error, no stale-current history after failure, retry with fresh events, slider keyboard behavior, dangling raw event, retraction-hidden display node, and drawer provenance.

- [ ] **Step 6: Independent reviewer gate**

The reviewer runs:

```bash
pnpm test
pnpm build
pnpm lint
```

Falsify `clears completed history when a refresh fails` by retaining the old `ready` events when `loadHistory` starts or fails. The targeted page test must fail because stale raw event text or the slider remains. Restore the state reset, rerun targeted and full verification. Also remove the repeated-cursor branch in Task 4 temporarily and confirm the UI's fake sees an unwanted third request, then restore it before the final run.

- [ ] **Step 7: Commit the reviewed history lens**

```bash
git add packages/web/src/atlas/AtlasHistoryLens.tsx packages/web/src/atlas/AtlasHistoryLens.test.tsx packages/web/src/atlas/AtlasPage.tsx packages/web/src/atlas/AtlasPage.test.tsx packages/web/src/atlas/AtlasDrawer.tsx packages/web/src/atlas/AtlasDrawer.test.tsx packages/web/src/atlas/atlas.css
git commit -m "Add recoverable atlas history lens"
```

### Task 8: prepare the v0.5.0 release and acceptance evidence

**Files:**

- Create: `packages/web/src/release.test.ts`
- Modify: `package.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/core/package.json`
- Modify: `packages/memory/package.json`
- Modify: `packages/providers/package.json`
- Modify: `packages/server/package.json`
- Modify: `packages/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `README.md`
- Modify: `ROADMAP.md`

**Interfaces:**

- Consumes: Tasks 1 through 7 and the workspace release conventions.
- Produces: consistent `0.5.0` metadata and documentation that claims only shipped Phase B and C behavior.

- [ ] **Step 1: Add the failing release-truth test**

Create `release.test.ts` using `readFile` and `fileURLToPath`, with no developer-specific path. It enumerates exactly root plus `cli`, `core`, `memory`, `providers`, `server`, and `web` manifests and asserts `version === '0.5.0'`. It also asserts README contains `Usable as a terminal app and a local browser app`, the deferred constellation limitation, and ROADMAP contains `v0.5.0 added the full-screen atlas`.

- [ ] **Step 2: Run the focused release test and observe the failure**

Run:

```bash
pnpm vitest run packages/web/src/release.test.ts
```

Expected: FAIL because the completed Phase B baseline is still v0.4.0 and its documentation has not made v0.5.0 claims.

- [ ] **Step 3: Update release metadata and documentation honestly**

Set the root and all six package manifests to `"version": "0.5.0"`; run `pnpm install --lockfile-only` and retain only expected lockfile changes. In README, add the exact Status opening:

```markdown
**Usable as a terminal app and a local browser app.**
```

State browser chat, session and transcript browsing, document browsing, the graph atlas, search and filters, full-screen document drawer, browser-local base positions, temporary realm influence, progressive labels, and faithful history time lens. State that browser reads remain available when the provider is unavailable while chat reports unavailable. List `server` and `web` in Architecture with the exact `web -> HTTP API only` dependency rule. Remove obsolete claims that web UI and graph visualization do not exist. Add this exact limitation:

```markdown
- Constellation layout and any saved shared layout are deferred. Atlas positions stay in this browser only and never change the memory folder.
```

Update ROADMAP Done with a v0.4.0 paragraph for local auth, web chat, browsing, and graph API, then add:

```markdown
v0.5.0 added the full-screen atlas: browser-local stable positions, realm anchors and temporary influence, search and type filtering, progressive labels, a semantic keyboard list, document reading, and a faithful graph-history time lens.
```

Remove Web interface and graph visualization from Up next, and add `Constellation layout and other atlas refinements` without implying memory-folder layout or relationship writes.

- [ ] **Step 4: Run focused and full acceptance**

Run:

```bash
pnpm vitest run packages/web/src/release.test.ts
pnpm test
pnpm build
pnpm lint
```

Expected: every command passes. Manually start the Phase B server with a synthetic memory folder, open its bootstrap URL, visit `/atlas`, exercise keyboard navigation, theme, deliberate node drag plus reload, history loading and retry, and a repeated-cursor fixture. Confirm atlas interaction makes no memory-folder change and history failure shows no prior history as current.

- [ ] **Step 5: Independent reviewer gate**

The reviewer independently runs all four commands above. Falsify the release test by setting `packages/web/package.json` to `0.4.0`; it must fail. Restore `0.5.0`. The reviewer repeats the manual synthetic-memory check, forces a malformed API response and a repeated cursor, and confirms `response_invalid` or the safe history error appears without leaked response details, stale history, memory writes, or non-GET atlas requests.

- [ ] **Step 6: Commit the reviewed release**

```bash
git add package.json packages/cli/package.json packages/core/package.json packages/memory/package.json packages/providers/package.json packages/server/package.json packages/web/package.json pnpm-lock.yaml README.md ROADMAP.md packages/web/src/release.test.ts
git commit -m "Release v0.5.0 atlas"
```

## Plan Self-Review

### Spec coverage

| Spec requirement | Planned task |
| --- | --- |
| Phase B atlas migration before Phase C directory | 1 |
| Zod validation of envelopes, graph data, documents, and events | 2 |
| Safe `response_invalid` behavior | 2 and 8 |
| Stable browser-local base positions and no memory writes | 3, 5, and 6 |
| Realm anchors and temporary direct influence | 5 |
| Falsified proof that influence cannot be saved | 5 and 6 |
| Full-screen reader, optional `docId`, promotion identity, unpaged nodes | 2, 3, and 6 |
| Search, filters, progressive labels, semantic keyboard list | 3, 5, and 6 |
| Complete faithful event stream and display-only fold | 4 and 7 |
| Repeated cursor, loading, failure, retry, no stale current history | 4 and 7 |
| Monochrome themes, focus and reduced motion | 5 and 6 |
| Version, README, ROADMAP, lockfile, and landing checks | 8 |
| Per-task tests, independent full verification, and falsification | Tasks 1 through 8 |

### Placeholder and type review

Every task identifies its files, produced interfaces, failing test behavior, concrete implementation boundary, commands, reviewer gate, falsification edit, and commit. Types use `AtlasBasePositions` for persistence and Graphology's distinct `baseX/baseY` plus rendered `x/y`, so later tasks cannot accidentally use one name for both coordinate domains. Optional `docId` and `sourceSessionId` remain optional schemas and conditionally rendered values, which is compatible with `exactOptionalPropertyTypes`.

### Boundary review

Only Task 2 fetches Phase B endpoints, and every call is validated, same-origin, and GET-only. Only Task 6 writes browser `localStorage`, through `saveAtlasBasePositions` and exclusively after a deliberate canvas drag. Realm influence has no storage callback and modifies only a short-lived Graphology graph's rendered `x/y`. History failure clears raw event and folded state before showing safe retry UI. No task can append or retract graph records, rewrite a document, modify a transcript, or write any memory-folder file.
