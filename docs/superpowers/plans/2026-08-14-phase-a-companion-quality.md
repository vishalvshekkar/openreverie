# Phase A companion quality implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daily use feel like talking to a companion: reverie opens the conversation, keeps a
maintained page for the people who matter, saves what you tell it without asking permission,
forgets on request, shows what it is doing while it thinks, and lets you read your own record from
the terminal.

**Architecture:** Six changes across the existing four packages, no new packages. The memory
package gains a `people/` document kind, a two pass reflection that stops overwriting narratives
blind, direct materialization in place of the proposal queue, and a `forget` operation built on the
already implemented but never emitted graph `retract` op. The core package gains an assistant first
`greet()` turn and a `thinking` agent event. The CLI package gains a provider free `read` subcommand
and an animated status line, both hand rolled, since the CLI has no third party dependencies and
will not gain any.

**Tech Stack:** TypeScript, Node 22+, pnpm workspace, vitest, zod, better-sqlite3, gray-matter,
ulid, smol-toml, biome. No new dependencies anywhere.

**Spec:** [docs/superpowers/specs/2026-08-14-phase-a-companion-quality-design.md](../specs/2026-08-14-phase-a-companion-quality-design.md)

## Global Constraints

Every task's requirements implicitly include this section. Copied from AGENTS.md and the spec.

- **Never use an em dash.** Anywhere: code comments, test names, CLI copy, prompt text, commit
  messages, this plan. Use commas, periods, colons, or parentheses.
- **No AI trope words** in any prose: delve, seamless, robust, leverage, streamline, empower,
  unlock, supercharge, "It's not just X, it's Y", emoji in headings or lists.
- **Package dependency order is `cli` -> `core` -> `memory` -> `providers`, downward only.** Never
  import upward or sideways.
- **Files are truth.** SQLite is derived and must stay rebuildable by `reverie reindex`. Nothing is
  ever stored only in the index.
- **Transcripts are sacred.** Append only, never modified, never deleted by code. No task in this
  plan writes to a transcript except to append.
- **Prose writes are atomic** via `writeDocumentAtomic` (temp file then rename). Graph writes are
  single line appends.
- **Validate all LLM structured output with zod at the boundary.**
- **TDD for deterministic logic.** Failing test first, run it and see it fail, minimal
  implementation, run it and see it pass, commit.
- **LLM dependent behavior is tested with fixture transcripts and schema assertions**, never golden
  text.
- **Fixtures are always synthetic.** Real personal data never enters the repo. A developer's own
  `.reverie/` never enters the repo.
- **No new third party dependency in `packages/cli`.** It currently has zero and stays that way.
- **Both safety modes ship unweakened.** No task here touches crisis behavior.
- **Commits are small, messages plain:** what changed and why, no ceremony, no `Co-Authored-By`
  trailer, no self congratulation.

Commands:

```
pnpm build                                          # tsc -b
pnpm test                                           # vitest run
pnpm lint                                           # biome check .
pnpm vitest run packages/<pkg>/src/<file>.test.ts   # one file
pnpm vitest run packages/<pkg>/src/<file>.test.ts -t "name"   # one test
```

After the branch merges, run `pnpm build` so the owner's npm linked `reverie` binary, which
symlinks into `packages/cli`, stays current.

## Compatibility, binding on every task

The owner's memory folder predates this work and is real personal data.

- No existing file changes format. `people/` is additive and created on open.
- Pending proposals in existing folders must still surface and still resolve end to end.
- `graph.jsonl` gains retract records, which `foldGraph` already handles.
- Sessions recorded before this release have no greeting line and must reflect exactly as they do
  today.

## Task order and rationale

| Task | Deliverable |
| --- | --- |
| 1 | `people/` directory and the `person` document kind |
| 2 | Person pages written when a person node is created |
| 3 | Documents reachable from graph nodes (`docIdForPath`, `docId` on graph results) |
| 4 | Reflection pass one returns update notes, not narrative prose |
| 5 | Reflection pass two rewrites narratives with the current body in hand (the defect fix) |
| 6 | Save by default: reflection materializes directly, proposal queue goes dormant |
| 7 | The `forget` tool |
| 8 | The `reverie read` subcommand |
| 9 | Recent session context widens beyond literally yesterday |
| 10 | `AgentSession.greet()` |
| 11 | The CLI opens the conversation, and empty sessions cost nothing |
| 12 | The `thinking` agent event |
| 13 | The status line |

Person pages come first because the read command and the greeting both benefit from them. The
narrative defect fix rides with them because they share the mechanism and person pages would
otherwise inherit the bug. Save by default lands after the reflection work so it changes one
already correct pipeline rather than two moving ones. The status line is last because it is the
piece judged by feel rather than by test.

---

### Task 1: people directory and the person document kind

**Files:**
- Modify: `packages/memory/src/paths.ts:9-20` (interface), `:22-35` (`memoryPaths`), `:41-47` (`ensureMemoryTree` dir loop)
- Modify: `packages/memory/src/sqlite.ts:12-18` (`DocKind`)
- Modify: `packages/memory/src/engine.ts` (`walkAllDocuments`, arcsDir loop at `:548-550` as of the current file; insert immediately after)
- Modify: `packages/core/src/tools.ts:90-96` (`search_memory`'s `kinds` property description)
- Test: `packages/memory/src/documents.test.ts` (`paths and ensureMemoryTree` describe block, lines 153-165 and 167-185)
- Test: `packages/memory/src/engine.test.ts` (new describe block)
- Test: `packages/core/src/tools.test.ts` (`toolDefinitions` describe block)

**Interfaces:**
- Consumes: existing `ensureMemoryTree(paths: MemoryPaths)`, `listDocuments(dir, onSkip?)`, `MemoryIndex.upsertDocument(doc, kind, embed)` (kind is a plain string param, not runtime-validated, so widening `DocKind` is a type-only change with no SQL migration).
- Produces: `MemoryPaths.peopleDir: string` and `DocKind` including `'person'`, both consumed by Task 2 and Task 3.

- [ ] **Step 1: Write the failing test (peopleDir on MemoryPaths and ensureMemoryTree)**

Extend the two existing exhaustive tests in `documents.test.ts` rather than adding parallel ones, since both currently claim to enumerate every field/dir and would silently stop being true otherwise.

```ts
  it('memoryPaths derives all expected paths under root', () => {
    const paths = memoryPaths(dir)
    expect(paths.root).toBe(dir)
    expect(paths.constitution).toBe(join(dir, 'constitution.md'))
    expect(paths.realmsDir).toBe(join(dir, 'realms'))
    expect(paths.arcsDir).toBe(join(dir, 'arcs'))
    expect(paths.peopleDir).toBe(join(dir, 'people'))
    expect(paths.sessionsDir).toBe(join(dir, 'sessions'))
    expect(paths.rollupsDailyDir).toBe(join(dir, 'rollups', 'daily'))
    expect(paths.rollupsWeeklyDir).toBe(join(dir, 'rollups', 'weekly'))
    expect(paths.graphLog).toBe(join(dir, 'graph.jsonl'))
    expect(paths.proposals).toBe(join(dir, 'proposals.jsonl'))
    expect(paths.indexDb).toBe(join(dir, 'index.db'))
  })

  it('creates all directories and seeds constitution.md once', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const constitution = await readDocument(paths.constitution)
    expect(typeof constitution.meta.id).toBe('string')
    expect(constitution.body).toContain('This constitution is empty. It grows as we talk.')

    for (const d of [
      paths.realmsDir,
      paths.arcsDir,
      paths.peopleDir,
      paths.sessionsDir,
      paths.rollupsDailyDir,
      paths.rollupsWeeklyDir,
    ]) {
      const stat = await readdir(d)
      expect(stat).toEqual([])
    }
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/memory/src/documents.test.ts`
Expected: FAIL. First test fails with `AssertionError: expected undefined to be '<dir>/people'` (`paths.peopleDir` does not exist yet). Second test fails with `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined`, from `readdir(paths.peopleDir)`.

- [ ] **Step 3: Add peopleDir to MemoryPaths, memoryPaths, and ensureMemoryTree**

```ts
export interface MemoryPaths {
  root: string
  constitution: string
  realmsDir: string
  arcsDir: string
  peopleDir: string
  sessionsDir: string
  rollupsDailyDir: string
  rollupsWeeklyDir: string
  graphLog: string
  proposals: string
  indexDb: string
}

export function memoryPaths(root: string): MemoryPaths {
  return {
    root,
    constitution: join(root, 'constitution.md'),
    realmsDir: join(root, 'realms'),
    arcsDir: join(root, 'arcs'),
    peopleDir: join(root, 'people'),
    sessionsDir: join(root, 'sessions'),
    rollupsDailyDir: join(root, 'rollups', 'daily'),
    rollupsWeeklyDir: join(root, 'rollups', 'weekly'),
    graphLog: join(root, 'graph.jsonl'),
    proposals: join(root, 'proposals.jsonl'),
    indexDb: join(root, 'index.db'),
  }
}
```

In `ensureMemoryTree`, add `paths.peopleDir` to the directory loop:

```ts
  for (const dir of [
    paths.realmsDir,
    paths.arcsDir,
    paths.peopleDir,
    paths.sessionsDir,
    paths.rollupsDailyDir,
    paths.rollupsWeeklyDir,
  ]) {
    await mkdir(dir, { recursive: true })
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/memory/src/documents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/paths.ts packages/memory/src/documents.test.ts
git commit -m "Add peopleDir to MemoryPaths and ensureMemoryTree"
```

- [ ] **Step 6: Write the failing test (person pages get indexed under kind person)**

Add a new describe block to `engine.test.ts`, right after the `resolveProposal materialization` block (after its closing `})` at line 461, before `describe('endSession idempotency', ...)`):

```ts
  describe('peopleDir indexing', () => {
    let dir: string
    let paths: MemoryPaths
    let engine: MemoryEngine

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-people-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
      engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    })

    afterEach(async () => {
      await engine.close()
      await rm(dir, { recursive: true, force: true })
    })

    it('reindexAll walks peopleDir and indexes person pages under kind person', async () => {
      const personDocId = newId('doc')
      const personDocPath = join(paths.peopleDir, 'sam.md')
      await writeDocumentAtomic({
        path: personDocPath,
        meta: { id: personDocId, name: 'Sam' },
        body: 'Sam is a close friend who shows up in a lot of stories about kayaking.\n',
      })

      await engine.reindexAll()

      const hits = await engine.search('kayaking')
      expect(hits.some((h) => h.docId === personDocId && h.kind === 'person')).toBe(true)

      const filteredHits = await engine.search('kayaking', { kinds: ['person'] })
      expect(filteredHits.some((h) => h.docId === personDocId)).toBe(true)
    })
  })
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "reindexAll walks peopleDir and indexes person pages under kind person"`
Expected: FAIL with `AssertionError: expected false to be true`, because `walkAllDocuments` never visits `peopleDir`, so the file written to it is never indexed and `hits` never contains it.

- [ ] **Step 8: Widen DocKind and walkAllDocuments**

In `sqlite.ts`:

```ts
export type DocKind =
  | 'constitution'
  | 'realm'
  | 'arc'
  | 'summary'
  | 'rollup_daily'
  | 'rollup_weekly'
  | 'person'
```

In `engine.ts`, inside `walkAllDocuments`, immediately after the `arcsDir` loop:

```ts
    for (const doc of await listDocuments(this.paths.arcsDir, this.onDocSkip)) {
      result.push({ doc, kind: 'arc' })
    }
    for (const doc of await listDocuments(this.paths.peopleDir, this.onDocSkip)) {
      result.push({ doc, kind: 'person' })
    }
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "reindexAll walks peopleDir and indexes person pages under kind person"`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/memory/src/sqlite.ts packages/memory/src/engine.ts packages/memory/src/engine.test.ts
git commit -m "Index person pages under peopleDir as DocKind person"
```

- [ ] **Step 11: Write the failing test (search_memory's kinds list mentions person)**

Add to `core/src/tools.test.ts`, inside `describe('toolDefinitions', ...)`, after the em dash test:

```ts
  it('lists person among the valid kinds for search_memory', () => {
    const defs = toolDefinitions()
    const searchMemory = defs.find((d) => d.name === 'search_memory')
    if (!searchMemory) throw new Error('expected a search_memory tool definition')
    const kinds = (
      searchMemory.parameters as { properties: { kinds: { description: string } } }
    ).properties.kinds
    expect(kinds.description).toContain('person')
  })
```

- [ ] **Step 12: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/tools.test.ts -t "lists person among the valid kinds for search_memory"`
Expected: FAIL with `AssertionError: expected '...rollup_daily, rollup_weekly. Omit to search across all kinds.' to contain 'person'`.

- [ ] **Step 13: Add person to the description string**

```ts
          kinds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Restrict results to these document kinds. Valid values: constitution, realm, arc, summary, ' +
              'rollup_daily, rollup_weekly, person. Omit to search across all kinds.',
          },
```

- [ ] **Step 14: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/tools.test.ts -t "lists person among the valid kinds for search_memory"`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add packages/core/src/tools.ts packages/core/src/tools.test.ts
git commit -m "List person among search_memory's valid kinds"
```

---

### Task 2: person pages written when a person node is created

**Files:**
- Modify: `packages/memory/src/engine.ts` (line numbers below are as of the file before Task 1 lands; Task 1 adds a few lines to `walkAllDocuments`, so use the named methods, not the raw numbers, to relocate each site)
  - `:87` (`ARC_STARTER_BODY` constant, add `PERSON_STARTER_BODY` beside it)
  - insert a new private method right after `materializeProposal` closes (`:682`) and before `resolveOrCreateRealm` (`:684`)
  - `:639-660` (`materializeProposal`'s `new_person` branch)
- Modify: `packages/memory/src/reflection.ts:402-415` (the narrative rewrite gate inside `applyReflection`, referred to in the spec as `reflection.ts:405`)
- Test: `packages/memory/src/engine.test.ts` (`resolveProposal materialization` describe block, after the "reuses an existing realm..." test at line 401)
- Test: `packages/memory/src/reflection.test.ts` (edit the existing test at line 453; add a new test beside it)

**Interfaces:**
- Consumes: `MemoryPaths.peopleDir` (Task 1), the existing private `uniqueSlug(dir, name)`, `writeDocumentAtomic`, `newId('person')` / `newId('doc')`, `this.syncGraph()`, `this.reindexDocument(doc, kind)`.
- Produces: `private async writePersonPage(name: string, nowIso: string): Promise<{ personNodeId: string; doc: Document }>` and `PERSON_STARTER_BODY = 'This page is new. It grows as we talk.\n'`. This helper is written as its own method, mirroring `resolveOrCreateRealm`, specifically so a later task (moving `newPersons` materialization directly into reflection, per spec section 2) can call it without going through a proposal at all. Also produces a narrative-rewrite gate that accepts `person` nodes, which core/tools.ts needs no change for since `dispatchTool` never inspects node types itself.

- [ ] **Step 1: Write the failing test (resolveProposal writes a person page)**

Add to the `resolveProposal materialization` describe block in `engine.test.ts`, after the "reuses an existing realm by id and dedupes arc filenames on a name collision" test:

```ts
    it('materializes a new person as a page with a doc pointer set on the node', async () => {
      const itemId = newId('item')
      const proposal: Proposal = {
        id: newId('prop'),
        ts: new Date().toISOString(),
        kind: 'new_person',
        summary: 'Add Sam as someone in your life.',
        payload: { name: 'Sam', itemIds: [itemId] },
        source: 'session_seed',
      }
      await appendProposals(paths, [proposal])

      await engine.resolveProposal(proposal.id, 'accepted')

      const pending = await pendingProposals(paths)
      expect(pending.find((p) => p.id === proposal.id)).toBeUndefined()

      const graph = await readGraph(paths)
      const personNode = [...graph.nodes.values()].find(
        (n) => n.type === 'person' && n.label === 'Sam',
      )
      if (!personNode) throw new Error('expected a person node to be created')
      if (!personNode.doc) throw new Error('expected the person node to carry a doc pointer')

      expect(graph.edges.get(`involves:${itemId}:${personNode.id}`)).toMatchObject({
        confirmed: true,
        confidence: 1,
      })

      const personDoc = await readDocument(personNode.doc)
      expect(personDoc.path).toBe(join(paths.peopleDir, 'sam.md'))
      expect(personDoc.meta.name).toBe('Sam')
      expect(personDoc.meta.node).toBe(personNode.id)
      expect(typeof personDoc.meta.opened).toBe('string')
      expect(personDoc.body).toBe('This page is new. It grows as we talk.\n')

      const hits = await engine.search('grows as we talk')
      expect(hits.some((h) => h.docId === personDoc.meta.id)).toBe(true)
    })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "materializes a new person as a page with a doc pointer set on the node"`
Expected: FAIL. It throws `Error: expected the person node to carry a doc pointer`, since the current `new_person` branch asserts the node with no `doc` field at all.

- [ ] **Step 3: Add PERSON_STARTER_BODY, writePersonPage, and wire it into materializeProposal**

```ts
const REALM_STARTER_BODY = 'This realm is new. It grows as we talk.\n'
const ARC_STARTER_BODY = 'This arc is new. It grows as we talk.\n'
const PERSON_STARTER_BODY = 'This page is new. It grows as we talk.\n'
```

New method, inserted right after `materializeProposal`'s closing brace and before `resolveOrCreateRealm`:

```ts
  // Writes a person's page and asserts their node with its doc pointer set
  // to the page path, mirroring what resolveOrCreateRealm does for realms.
  // Kept as its own method, not inlined into materializeProposal, because
  // the direct-materialization move planned for reflection's newPersons
  // will call this same helper instead of going through a proposal at all.
  private async writePersonPage(
    name: string,
    nowIso: string,
  ): Promise<{ personNodeId: string; doc: Document }> {
    const personNodeId = newId('person')
    const slug = await uniqueSlug(this.paths.peopleDir, name)
    const personPath = join(this.paths.peopleDir, `${slug}.md`)
    const doc: Document = {
      path: personPath,
      meta: { id: newId('doc'), name, node: personNodeId, opened: nowIso },
      body: PERSON_STARTER_BODY,
    }
    await writeDocumentAtomic(doc)
    await appendGraph(this.paths, [
      { ts: nowIso, op: 'assert', node: personNodeId, type: 'person', label: name, doc: personPath },
    ])
    await this.syncGraph()
    await this.reindexDocument(doc, 'person')
    return { personNodeId, doc }
  }
```

Replace the `new_person` branch of `materializeProposal`:

```ts
    if (proposal.kind === 'new_person') {
      const payload = proposal.payload as { name: string; itemIds: string[] }
      const { personNodeId } = await this.writePersonPage(payload.name, nowIso)
      const records: GraphRecord[] = []
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "materializes a new person as a page with a doc pointer set on the node"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/engine.ts packages/memory/src/engine.test.ts
git commit -m "Write a person page and doc pointer when materializing a new_person proposal"
```

- [ ] **Step 6: Update the existing gate test and write the new failing test**

The test at `reflection.test.ts:453` currently proves the narrative rewrite gate refuses a non-arc node by using a `person` node as its example. That example stops being correct once the gate is widened: before this change `arc` was the only node type with a maintained narrative document, so a `person_` id showing up in `arcNarratives` could only be a model mistake, and honoring it would silently overwrite an unrelated file. After this change, person pages are a maintained document kind with their own `doc` pointer, so a `person_` id there is a legitimate target, and refusing it would silently drop the person's narrative instead of protecting anything. The test needs a node type that is genuinely still outside the allowlist, so switch it to `entity`, which keeps the same protective test alive for the right reason.

Replace the test in `reflection.test.ts`:

```ts
    it('does not rewrite an entity node document even when arcNarratives names it and it has a doc', async () => {
      const entityDocPath = join(paths.realmsDir, 'entity.md')
      await writeDocumentAtomic({
        path: entityDocPath,
        meta: { id: newId('doc'), name: 'Some Entity' },
        body: 'Original entity notes.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'entity_thing',
          type: 'entity',
          label: 'Some Entity',
          doc: entityDocPath,
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session.'),
        arcNarratives: [{ arcId: 'entity_thing', narrative: 'This should never land anywhere.' }],
      }

      const result = await applyReflection(paths, out, sessionId, [], now)
      expect(result.skippedNarratives).toBe(1)

      const entityDoc = await readDocument(entityDocPath)
      expect(entityDoc.body).toBe('Original entity notes.\n')
      expect(entityDoc.meta.updated).toBeUndefined()
    })

    it('rewrites a person node document when arcNarratives names it, the same as an arc', async () => {
      const personDocPath = join(paths.peopleDir, 'sam.md')
      await writeDocumentAtomic({
        path: personDocPath,
        meta: {
          id: newId('doc'),
          name: 'Sam',
          node: 'person_sam',
          opened: '2026-08-01T00:00:00.000Z',
        },
        body: 'Original person notes.\n',
      })
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_sam',
          type: 'person',
          label: 'Sam',
          doc: personDocPath,
        },
      ])

      const out: ReflectionOutput = {
        ...emptyReflectionOutput('A session about Sam.'),
        arcNarratives: [{ arcId: 'person_sam', narrative: 'Sam and I caught up after months apart.' }],
      }

      const result = await applyReflection(paths, out, sessionId, [], now)
      expect(result.skippedNarratives).toBe(0)

      const personDoc = await readDocument(personDocPath)
      expect(personDoc.body).toBe('Sam and I caught up after months apart.\n')
      expect(personDoc.meta.updated).toBe(now.toISOString())
      expect(personDoc.meta.name).toBe('Sam')
    })
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts -t "rewrites a person node document when arcNarratives names it, the same as an arc"`
Expected: FAIL with `AssertionError: expected 1 to be 0`, since the gate still refuses anything but `arc`. (The renamed entity test passes unchanged, since `entity` was already, and remains, outside the allowlist.)

- [ ] **Step 8: Widen the narrative rewrite gate to accept person nodes**

```ts
  const narrativeWrites: PendingWrite[] = []
  for (const narrative of out.arcNarratives) {
    const node = graphState.nodes.get(narrative.arcId)
    if (node === undefined || (node.type !== 'arc' && node.type !== 'person') || !node.doc) {
      skippedNarratives += 1
      continue
    }
    const doc = await readDocument(node.doc)
    narrativeWrites.push({
      path: doc.path,
      meta: { ...doc.meta, updated: nowIso },
      body: narrative.narrative,
    })
  }
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts`
Expected: PASS, including the renamed entity test and the new person test.

- [ ] **Step 10: Commit**

```bash
git add packages/memory/src/reflection.ts packages/memory/src/reflection.test.ts
git commit -m "Let reflection's narrative rewrite target person nodes as well as arcs"
```

---

### Task 3: documents reachable from graph nodes

GraphNode.doc holds a filesystem path, but read_document (and its tool) takes a document id, so a node discovered through graph_query currently points at a document the model has no way to open.

**Files:**
- Modify: `packages/memory/src/engine.ts` (line numbers below are as of the file before Tasks 1 and 2 land; both add lines above these sites, so anchor on the named method, not the number, when the file has moved)
  - `:94` (`docPaths` field declaration, add a sibling map)
  - `:339-343` (`graphQuery`)
  - `:345-357` (`readDocumentById`, add `docIdForPath` beside it)
  - `:485` (inside `reindexAll`)
  - `:512` (inside `reindexDocument`)
  - `:539` (inside `refreshDocPaths`)
- Test: `packages/memory/src/engine.test.ts` (new describe block, after `peopleDir indexing` from Task 1)

**Interfaces:**
- Consumes: the existing `docPaths` maintenance sites in `reindexAll`, `reindexDocument`, and `refreshDocPaths` (all three already touch `doc.path` and `doc.meta.id`), and `GraphNode.doc?: string` from `graph.ts`.
- Produces: `docIdForPath(path: string): string | undefined` (exact signature required by the interface contract), and `graphQuery(query: GraphQuery): unknown[]` results where any node carrying a `doc` also carries a `docId: string`. This is what closes the gap the spec calls out for people now, and what the Phase C web graph view depends on later.

- [ ] **Step 1: Write the failing test**

Add a new describe block to `engine.test.ts`, after the `peopleDir indexing` block added in Task 1:

```ts
  describe('docIdForPath and graph_query docId', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-docid-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('resolves a doc path to its document id, and carries docId on graph nodes that have a doc but not on ones that do not', async () => {
      const arcDocId = newId('doc')
      const arcDocPath = join(paths.arcsDir, 'health.md')
      await writeDocumentAtomic({
        path: arcDocPath,
        meta: { id: arcDocId, name: 'Health', status: 'active' },
        body: 'Original arc narrative.\n',
      })
      const itemId = newId('item')
      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'arc_health',
          type: 'arc',
          label: 'Health',
          doc: arcDocPath,
        },
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: itemId,
          type: 'item',
          label: 'Went for a run',
        },
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          edge: 'part_of',
          from: itemId,
          to: 'arc_health',
          confidence: 1,
          confirmed: true,
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      expect(engine.docIdForPath(arcDocPath)).toBe(arcDocId)

      const neighbors = engine.graphQuery({ kind: 'neighbors', nodeId: itemId }) as {
        edge: { edge: string }
        node: { id: string; docId?: string }
      }[]
      const arcNeighbor = neighbors.find((n) => n.node.id === 'arc_health')
      expect(arcNeighbor?.node.docId).toBe(arcDocId)

      // The item node itself carries no doc in this fixture, so it must
      // carry no docId either: docId is derived only from a present doc.
      const itemsInArc = engine.graphQuery({ kind: 'items_in_arc', arcId: 'arc_health' }) as {
        id: string
        docId?: string
      }[]
      expect(itemsInArc[0]?.docId).toBeUndefined()

      await engine.close()
    })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "resolves a doc path to its document id, and carries docId on graph nodes that have a doc but not on ones that do not"`
Expected: FAIL with `TypeError: engine.docIdForPath is not a function`.

- [ ] **Step 3: Add the reverse map, docIdForPath, and wire it into graphQuery**

Beside the `docPaths` field:

```ts
  private docPaths = new Map<string, string>()
  private docIdByPath = new Map<string, string>()
```

`graphQuery`, attaching `docId` to any node that has a `doc`:

```ts
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
```

Maintain `docIdByPath` at every existing site that maintains `docPaths`. In `reindexAll`:

```ts
    this.docPaths = new Map(docs.map(({ doc }) => [doc.meta.id, doc.path]))
    this.docIdByPath = new Map(docs.map(({ doc }) => [doc.path, doc.meta.id]))
```

In `reindexDocument`:

```ts
    this.docPaths.set(doc.meta.id, doc.path)
    this.docIdByPath.set(doc.path, doc.meta.id)
```

In `refreshDocPaths`:

```ts
    this.docPaths = new Map(docs.map(({ doc }) => [doc.meta.id, doc.path]))
    this.docIdByPath = new Map(docs.map(({ doc }) => [doc.path, doc.meta.id]))
```

The map is keyed by path, not id, so when a path is rewritten with a fresh doc id (the `summary.md` case, minted anew on every reflection), the later `.set` simply supersedes the older entry at that path. This is the correct behavior and mirrors what `removeDocumentsAtPath` already does for the SQL side.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "resolves a doc path to its document id, and carries docId on graph nodes that have a doc but not on ones that do not"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/engine.ts packages/memory/src/engine.test.ts
git commit -m "Add MemoryEngine.docIdForPath and include docId in graph_query results"
```

---

### Task 4: reflection pass one returns update notes, not narrative prose

**Files:**
- Modify: `packages/memory/src/reflection.ts:34` (drop `CONFIDENCE_THRESHOLD`? no, stays for Task 6; leave as is here), `:45-59` (`ReflectionOutput`, `ReflectionContext`), `:63-82` (`reflectionOutputSchema`), `:95-103` (`RESPONSE_SHAPE`), `:105-126` (`buildReflectionPrompt`), `:267-463` (`applyReflection`: drop the narrative-writing block and `skippedNarratives`)
- Modify: `packages/memory/src/engine.ts:491-496` (`buildReflectionContext` gains `people`), `:185-242` (`_doEndSession`: rename degraded fallback fields, drop the dead arc-narrative reindex loop)
- Test: `packages/memory/src/reflection.test.ts:28-38` (`emptyReflectionOutput`), `:102-123` (prompt listing test, extended), `:226-358` (main `applyReflection` test, narrative assertions dropped), `:453-482` (deleted, superseded by Task 5's `resolveNarratives` tests), `:551-553` (unaffected, `CONFIDENCE_THRESHOLD` stays until Task 6)
- Test: `packages/memory/src/engine.test.ts:22-32` (`emptyReflectionOutput`), `:86-104` (`scriptedReflection` literal), new test for `people` wiring through `buildReflectionContext`

**Interfaces:**
- Consumes: `GraphNode` from `./graph.js`, `z` from `zod`, existing `readDocument`/`writeDocumentAtomic` from `./documents.js`
- Produces:
  ```ts
  export interface ReflectionOutput {
    summary: string
    items: { text: string; kind: ReflectionItemKind }[]
    attributions: { itemIndex: number; arcId: string; confidence: number }[]
    newArcs: { name: string; realm: string; reason: string; itemIndexes: number[]; narrative: string }[]
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
  ```

- [ ] **Step 1: Write the failing test for the widened prompt**

```ts
// packages/memory/src/reflection.test.ts, inside describe('reflectSession')
it('lists known people by id and label, and states what makes someone worth a person page', async () => {
  const out = emptyReflectionOutput('A session mentioning a few names.')
  const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])

  await reflectSession({ chat, model: 'fake-model' }, TRANSCRIPT, {
    constitution: 'Empty constitution.',
    arcs: [],
    realms: [],
    people: [{ id: 'person_sam', type: 'person', label: 'Sam', ts: '2026-08-01T00:00:00.000Z' }],
  })

  const prompt = chat.requests[0]?.messages[0]?.content ?? ''
  expect(prompt).toContain('Known people:')
  expect(prompt).toContain('person_sam: Sam')
  expect(prompt).toContain("recurs in this person's life")
  expect(prompt).toContain('"arcUpdates": [{"arcId": string, "note": string}]')
  expect(prompt).toContain('"personUpdates": [{"personId": string, "note": string}]')
  expect(prompt).not.toContain('arcNarratives')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts -t "lists known people by id and label"`
Expected: FAIL. `context.people` does not exist on the object literal at the type level, and at runtime the prompt has no "Known people:" section and still says `arcNarratives`, so the `toContain` assertions fail.

- [ ] **Step 3: Update the output shape, schema, response shape, and prompt**

```ts
// reflection.ts, replacing the ReflectionOutput/ReflectionContext block
export interface ReflectionOutput {
  summary: string
  items: { text: string; kind: ReflectionItemKind }[]
  attributions: { itemIndex: number; arcId: string; confidence: number }[]
  newArcs: { name: string; realm: string; reason: string; itemIndexes: number[]; narrative: string }[]
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
```

```ts
// reflection.ts, replacing RESPONSE_SHAPE
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
```

```ts
// reflection.ts, replacing buildReflectionPrompt
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
```

Also delete the narrative-writing block from `applyReflection` (it read `out.arcNarratives`, which no longer exists):

```ts
// reflection.ts, applyReflection: remove this block entirely
// const narrativeWrites: PendingWrite[] = []
// for (const narrative of out.arcNarratives) { ... }
```

and drop `skippedNarratives` from the counted variables and the return statement, and from the return type:

```ts
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
}> {
```

(the `for (const write of narrativeWrites) { await writeDocumentAtomic(write) }` loop and the `let skippedNarratives = 0` line go with it; the final `return` drops `skippedNarratives`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts -t "lists known people by id and label"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/reflection.ts
git commit -m "$(cat <<'EOF'
Widen the reflection prompt with a known-people listing and drop arc narratives from pass one

Pass one now returns short update notes (arcUpdates, personUpdates) instead of
full narrative prose, and states plainly what makes a person worth a page.
EOF
)"
```

- [ ] **Step 6: Write the failing test for applyReflection's new shape (fixtures updated, narrative writing removed)**

```ts
// packages/memory/src/reflection.test.ts
function emptyReflectionOutput(summary: string): ReflectionOutput {
  return {
    summary,
    items: [],
    attributions: [],
    newArcs: [],
    newPersons: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
  }
}
```

```ts
// replaces the body of 'writes the summary, splits attributions by confidence, and queues proposals'
it('writes the summary, splits attributions by confidence, and queues proposals for new arcs and persons', async () => {
  const out: ReflectionOutput = {
    summary: 'Talked about a morning run and an upcoming deadline.',
    items: [
      { text: 'Went for a long run', kind: 'event' },
      { text: 'Feeling anxious about a work deadline', kind: 'feeling' },
    ],
    attributions: [
      { itemIndex: 0, arcId: 'arc_health', confidence: 0.9 },
      { itemIndex: 1, arcId: 'arc_unknown', confidence: 0.3 },
    ],
    newArcs: [
      {
        name: 'marathon training',
        realm: 'realm_health',
        reason: 'mentioned running multiple times',
        itemIndexes: [0],
        narrative: 'Training for a marathon this fall.',
      },
    ],
    newPersons: [
      {
        name: 'Sam',
        reason: 'mentioned as a running partner',
        itemIndexes: [1],
        narrative: 'Sam is a running partner.',
      },
    ],
    arcUpdates: [{ arcId: 'arc_health', note: 'Went for another run.' }],
    personUpdates: [],
    constitutionUpdate: null,
  }

  const result = await applyReflection(paths, out, sessionId, [], now)

  expect(result.summaryDoc.body).toBe(`${out.summary}\n`)
  expect(result.autoAsserted).toBe(1)

  const proposals = await pendingProposals(paths)
  expect(proposals).toHaveLength(3)
  const newArcProposal = proposals.find((p) => p.kind === 'new_arc')
  expect(newArcProposal?.payload).toEqual({
    name: 'marathon training',
    realm: 'realm_health',
    itemIds: [(result.summaryDoc.meta.items as ReflectionItem[])[0]?.id],
  })

  // arcUpdates carries no narrative prose in this task; applyReflection does
  // not touch the arc document for it. Pass two (Task 5) is what rewrites it.
  const arcDoc = await readDocument(arcDocPath)
  expect(arcDoc.body).toBe('Original arc narrative.\n')
  expect(arcDoc.meta.updated).toBeUndefined()
})
```

Also delete the now-dead test `'does not rewrite a non-arc node document even when arcNarratives names it and it has a doc'` (lines 453-482): `applyReflection` no longer reads any narrative field at all, so there is nothing left for that test to exercise. Its coverage of "person nodes are a valid rewrite target" moves to Task 5's `resolveNarratives` tests.

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts -t "writes the summary, splits attributions by confidence"`
Expected: FAIL with `TypeError: out.arcNarratives is not iterable` (the current `applyReflection` still loops over `out.arcNarratives`, which is now `undefined` on this fixture).

- [ ] **Step 8: Remove narrative writing from applyReflection**

(Already written in Step 3's code block; this step is the checkpoint that the deletion is in place and the file has no remaining reference to `arcNarratives` or `skippedNarratives`.)

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 10: Commit**

```bash
git add packages/memory/src/reflection.ts packages/memory/src/reflection.test.ts
git commit -m "$(cat <<'EOF'
Stop writing arc narratives inside applyReflection

Narrative prose is no longer part of the reflection output applyReflection
consumes. The arcUpdates/personUpdates notes it now sees are informational
only until pass two (next task) turns them into a document rewrite.
EOF
)"
```

- [ ] **Step 11: Write the failing test proving the engine wires people into the prompt**

```ts
// packages/memory/src/engine.test.ts, new describe block
describe('buildReflectionContext people wiring', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-people-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('includes existing people in the reflection prompt built by the engine', async () => {
    await appendGraph(paths, [
      { ts: '2026-08-01T00:00:00.000Z', op: 'assert', node: 'person_sam', type: 'person', label: 'Sam' },
    ])

    const chat = new FakeChatProvider([
      { text: JSON.stringify(emptyReflectionOutput('A session.')), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))

    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'Hello there.',
    })
    await engine.endSession(sessionId)

    const prompt = chat.requests[0]?.messages[0]?.content ?? ''
    expect(prompt).toContain('person_sam: Sam')

    await engine.close()
  })
})
```

Also update the engine.test.ts helper and fixture to the new shape:

```ts
function emptyReflectionOutput(summary: string): ReflectionOutput {
  return {
    summary,
    items: [],
    attributions: [],
    newArcs: [],
    newPersons: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
  }
}
```

and, in the lifecycle test's `scriptedReflection` literal, replace `newArcs: [{ ..., itemIndexes: [1] }]` with `newArcs: [{ ..., itemIndexes: [1], narrative: 'Presentation prep starts here.' }]`, `newPersons: []` stays, and `arcNarratives: []` becomes `arcUpdates: [], personUpdates: []`.

- [ ] **Step 12: Run the test to verify it fails**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "includes existing people in the reflection prompt"`
Expected: FAIL. `buildReflectionContext` does not populate `people`, so `renderListing(context.people)` throws `TypeError: Cannot read properties of undefined (reading 'length')`, and `engine.endSession` rejects.

- [ ] **Step 13: Wire people through buildReflectionContext and fix _doEndSession's degraded fallback**

```ts
// engine.ts
private async buildReflectionContext(): Promise<ReflectionContext> {
  const constitutionDoc = await readDocument(this.paths.constitution)
  const arcs = [...this.graphState.nodes.values()].filter((node) => node.type === 'arc')
  const realms = [...this.graphState.nodes.values()].filter((node) => node.type === 'realm')
  const people = [...this.graphState.nodes.values()].filter((node) => node.type === 'person')
  return { constitution: constitutionDoc.body, arcs, realms, people }
}
```

```ts
// engine.ts, _doEndSession: replace the degraded-fallback object literal
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
```

```ts
// engine.ts, _doEndSession: remove the dead narrative reindex loop
// for (const narrative of out.arcNarratives) { ... }
// Pass two (next task) will reindex any document it actually rewrites.
```

- [ ] **Step 14: Run the test to verify it passes**

Run: `pnpm vitest run packages/memory/src/engine.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 15: Commit**

```bash
git add packages/memory/src/engine.ts packages/memory/src/engine.test.ts
git commit -m "$(cat <<'EOF'
Pass known people into the reflection prompt from the engine

buildReflectionContext now reads person nodes off the graph the same way it
already reads arcs and realms, and the degraded-session fallback matches the
new ReflectionOutput shape.
EOF
)"
```

---

### Task 5: reflection pass two rewrites narratives with the current body in hand

Reflection currently overwrites arc bodies without ever seeing the previous body, so accumulated
narrative is destroyed every session that touches the arc. `reflection.ts:110` puts the
constitution's current body in the prompt; nothing in the (now-removed) narrative path ever did
the same for an arc. No test caught it because every test asserted the arc body equals the new
narrative, which was the buggy behavior recorded as the expectation
(the deleted `reflection.test.ts:252` fixture). This task fixes it with a second LLM pass that
receives the document's current body and is told to carry forward what still matters.

**Files:**
- Modify: `packages/memory/src/reflection.ts:267-` (`applyReflection` gains a sixth parameter), new exports `narrativeRewriteSchema`, `rewriteNarrative`, `resolveNarratives`
- Modify: `packages/memory/src/engine.ts:185-242` (`_doEndSession`: call `resolveNarratives` between `reflectSession` and `applyReflection`, reindex whatever it rewrites)
- Test: `packages/memory/src/reflection.test.ts` (new `describe('rewriteNarrative')`, new `describe('resolveNarratives')`, every existing `applyReflection(...)` call gains a sixth `new Map()` argument)
- Test: `packages/memory/src/engine.test.ts` (every `applyReflection(...)` call gains a sixth `new Map()` argument)

**Interfaces:**
- Consumes: `ChatProvider` from `@openreverie/providers`, `GraphState` from `./graph.js`
- Produces:
  ```ts
  export const narrativeRewriteSchema: z.ZodType<{ body: string }>

  export async function rewriteNarrative(
    chat: ChatProvider,
    model: string,
    input: { name: string; currentBody: string; summary: string; itemTexts: string[]; note: string },
  ): Promise<{ body: string } | null>

  export async function resolveNarratives(
    paths: MemoryPaths,
    graphState: GraphState,
    out: ReflectionOutput,
    chat: ChatProvider,
    model: string,
  ): Promise<Map<string, string>>

  export async function applyReflection(
    paths: MemoryPaths,
    out: ReflectionOutput,
    sessionId: string,
    liveItems: ReflectionItem[],
    now: Date,
    narratives: Map<string, string>,
  ): Promise<{ summaryDoc: Document; autoAsserted: number; proposals: Proposal[]; droppedProposals: number }>
  ```

- [ ] **Step 1: Write the failing test for rewriteNarrative's schema and retry**

```ts
// packages/memory/src/reflection.test.ts, new describe block
describe('rewriteNarrative', () => {
  it('returns the parsed body on the first valid reply', async () => {
    const chat = new FakeChatProvider([{ text: JSON.stringify({ body: 'Updated body.' }), toolCalls: [] }])

    const result = await rewriteNarrative(chat, 'fake-model', {
      name: 'Health',
      currentBody: 'Original arc narrative.\n',
      summary: 'A quiet session.',
      itemTexts: ['Went for a run'],
      note: 'Went for another run.',
    })

    expect(result).toEqual({ body: 'Updated body.' })
    expect(chat.requests).toHaveLength(1)
    const prompt = chat.requests[0]?.messages[0]?.content ?? ''
    expect(prompt).toContain('Original arc narrative.')
    expect(prompt).toContain('Went for another run.')
  })

  it('retries once on malformed JSON, then returns null if the retry also fails', async () => {
    const chat = new FakeChatProvider([
      { text: 'not json', toolCalls: [] },
      { text: 'still not json', toolCalls: [] },
    ])

    const result = await rewriteNarrative(chat, 'fake-model', {
      name: 'Health',
      currentBody: 'Original arc narrative.\n',
      summary: 'A quiet session.',
      itemTexts: [],
      note: 'Went for another run.',
    })

    expect(result).toBeNull()
    expect(chat.requests).toHaveLength(2)
    const retryPrompt = chat.requests[1]?.messages[0]?.content ?? ''
    expect(retryPrompt).toContain('failed validation')
    expect(retryPrompt).toContain('not json')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts -t "rewriteNarrative"`
Expected: FAIL with `ReferenceError: rewriteNarrative is not defined` (not exported yet).

- [ ] **Step 3: Implement narrativeRewriteSchema and rewriteNarrative**

```ts
// reflection.ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts -t "rewriteNarrative"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/reflection.ts
git commit -m "$(cat <<'EOF'
Add rewriteNarrative, a one-shot pass-two rewrite call with the current body in hand

One retry on parse or schema failure, then null. A null result is the caller's
signal to leave the existing document untouched.
EOF
)"
```

- [ ] **Step 6: Write the failing tests for resolveNarratives (resolution, drop rules, overlap)**

```ts
// packages/memory/src/reflection.test.ts, new describe block (beforeEach already seeds
// arc_health at arcDocPath with body 'Original arc narrative.\n')
describe('resolveNarratives', () => {
  it('calls rewriteNarrative once per arcUpdates entry that resolves to an existing arc with a doc', async () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      items: [{ text: 'Went for a run', kind: 'event' }],
      attributions: [{ itemIndex: 0, arcId: 'arc_health', confidence: 0.9 }],
      arcUpdates: [{ arcId: 'arc_health', note: 'Went for another run.' }],
    }
    const chat = new FakeChatProvider([{ text: JSON.stringify({ body: 'New body.' }), toolCalls: [] }])

    const graphState = await readGraph(paths)
    const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

    expect(narratives.get('arc_health')).toBe('New body.')
    expect(chat.requests).toHaveLength(1)
    const prompt = chat.requests[0]?.messages[0]?.content ?? ''
    expect(prompt).toContain('Original arc narrative.')
    expect(prompt).toContain('Went for a run')
  })

  it('drops an arcUpdates entry whose id does not resolve to an existing node', async () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      arcUpdates: [{ arcId: 'arc_does_not_exist', note: 'Should be dropped.' }],
    }
    const chat = new FakeChatProvider([])

    const graphState = await readGraph(paths)
    const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

    expect(narratives.size).toBe(0)
    expect(chat.requests).toHaveLength(0)
  })

  it('drops a personUpdates entry that resolves to a node with no doc', async () => {
    await appendGraph(paths, [
      { ts: '2026-08-01T00:00:00.000Z', op: 'assert', node: 'person_sam', type: 'person', label: 'Sam' },
    ])
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      personUpdates: [{ personId: 'person_sam', note: 'Should be dropped, no doc.' }],
    }
    const chat = new FakeChatProvider([])

    const graphState = await readGraph(paths)
    const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

    expect(narratives.size).toBe(0)
    expect(chat.requests).toHaveLength(0)
  })

  it('drops an update entry that resolves to a node that is neither arc nor person', async () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      arcUpdates: [{ arcId: 'realm_health', note: 'A realm is not a valid pass two target.' }],
    }
    const chat = new FakeChatProvider([])

    const graphState = await readGraph(paths)
    const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

    expect(narratives.size).toBe(0)
    expect(chat.requests).toHaveLength(0)
  })

  it('drops the map entry when rewriteNarrative itself returns null', async () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session.'),
      arcUpdates: [{ arcId: 'arc_health', note: 'Went for another run.' }],
    }
    const chat = new FakeChatProvider([
      { text: 'not json', toolCalls: [] },
      { text: 'still not json', toolCalls: [] },
    ])

    const graphState = await readGraph(paths)
    const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

    expect(narratives.has('arc_health')).toBe(false)
  })

  it('drops the arcUpdates entry for an arc also named in newArcs this session', async () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session with a naming collision.'),
      newArcs: [
        {
          name: 'Health',
          realm: 'realm_health',
          reason: 'mistakenly proposed again',
          itemIndexes: [],
          narrative: 'unused',
        },
      ],
      arcUpdates: [{ arcId: 'arc_health', note: 'Should be dropped due to overlap.' }],
    }
    const chat = new FakeChatProvider([])

    const graphState = await readGraph(paths)
    const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')

    expect(narratives.has('arc_health')).toBe(false)
    expect(chat.requests).toHaveLength(0)
  })
})
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts -t "resolveNarratives"`
Expected: FAIL with `ReferenceError: resolveNarratives is not defined`.

- [ ] **Step 8: Implement resolveNarratives**

```ts
// reflection.ts
export async function resolveNarratives(
  paths: MemoryPaths,
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
    if (!node || node.type !== 'arc' || !node.doc) {
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
    if (!node || node.type !== 'person' || !node.doc) {
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
```

`paths` is accepted for signature symmetry with the rest of the module's public functions and for a possible future disk-backed lookup; the current implementation resolves documents through `graphState` and `readDocument` alone.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts -t "resolveNarratives"`
Expected: PASS, all six cases.

- [ ] **Step 10: Commit**

```bash
git add packages/memory/src/reflection.ts
git commit -m "$(cat <<'EOF'
Add resolveNarratives to run pass two once per arc or person update

Drops entries that do not resolve to an existing arc or person with a doc,
and drops an update for anything also proposed as new this same session.
EOF
)"
```

- [ ] **Step 11: Write the failing test for applyReflection's sixth parameter**

```ts
// packages/memory/src/reflection.test.ts, inside describe('applyReflection')
it('writes a narrative document only for ids present in the narratives map', async () => {
  const out = emptyReflectionOutput('A session.')
  const narratives = new Map([['arc_health', 'Rewritten by pass two.']])

  await applyReflection(paths, out, sessionId, [], now, narratives)

  const arcDoc = await readDocument(arcDocPath)
  expect(arcDoc.body).toBe('Rewritten by pass two.\n')
  expect(arcDoc.meta.updated).toBe(now.toISOString())
})

it('leaves the arc document byte for byte unchanged when the narratives map has no entry for it', async () => {
  const out = emptyReflectionOutput('A session.')
  const before = await readDocument(arcDocPath)

  await applyReflection(paths, out, sessionId, [], now, new Map())

  const after = await readDocument(arcDocPath)
  expect(after.body).toBe(before.body)
  expect(after.meta.updated).toBeUndefined()
})
```

Every other existing call to `applyReflection(...)` in `reflection.test.ts` and `engine.test.ts` (there are roughly a dozen) gets a sixth argument, `new Map()`, mechanically. For example, line 256 becomes:

```ts
const result = await applyReflection(paths, out, sessionId, [], now, new Map())
```

- [ ] **Step 12: Run the tests to verify they fail**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts -t "writes a narrative document only for ids present"`
Expected: FAIL with a TypeScript arity mismatch surfaced at runtime as `TypeError: undefined is not a valid narratives map` once the implementation below reads `narratives.entries()`, or simply `narratives is not defined` before Step 13 lands. (Without Step 13, `applyReflection` still has five parameters, so the sixth argument is silently ignored and the assertion on the rewritten body fails.)

- [ ] **Step 13: Add the sixth parameter and narrative writing to applyReflection**

```ts
// reflection.ts
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
  proposals: Proposal[]
  droppedProposals: number
}> {
  // ...unchanged setup through graphRecords/proposals construction...

  const narrativeWrites: PendingWrite[] = []
  for (const [id, body] of narratives) {
    const node = graphState.nodes.get(id)
    if (!node?.doc) {
      continue
    }
    const doc = await readDocument(node.doc)
    narrativeWrites.push({ path: doc.path, meta: { ...doc.meta, updated: nowIso }, body })
  }

  // ...unchanged constitutionWrite construction...

  await appendGraph(paths, graphRecords)
  await appendProposals(paths, proposals)

  for (const write of narrativeWrites) {
    await writeDocumentAtomic(write)
  }

  if (constitutionWrite) {
    await writeDocumentAtomic(constitutionWrite)
  }

  // ...unchanged summary.md write and return...
}
```

- [ ] **Step 14: Run the tests to verify they pass**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts`
Expected: PASS, all tests in the file green, including the two new ones and every existing call updated with `new Map()`.

- [ ] **Step 15: Commit**

```bash
git add packages/memory/src/reflection.ts packages/memory/src/reflection.test.ts
git commit -m "$(cat <<'EOF'
Let applyReflection write pass-two narratives from an explicit map

The caller decides what got rewritten (resolveNarratives) and hands the body
straight to applyReflection, which stays deterministic: it only ever reads
the map, never calls a model.
EOF
)"
```

- [ ] **Step 16: Write the most important test: narrative continuity across two consecutive reflections**

```ts
// packages/memory/src/reflection.test.ts, new describe block
describe('narrative continuity across sessions', () => {
  it('carries forward what a previous pass-two rewrite established, across two consecutive reflections', async () => {
    const firstOut: ReflectionOutput = {
      ...emptyReflectionOutput('First session: started marathon training.'),
      items: [{ text: 'Went for a 5k run', kind: 'event' }],
      attributions: [{ itemIndex: 0, arcId: 'arc_health', confidence: 0.9 }],
      arcUpdates: [{ arcId: 'arc_health', note: 'Started marathon training with a 5k run.' }],
    }
    const firstRewrittenBody = 'Training log:\n- Ran a 5k to start marathon training.\n'
    const firstChat = new FakeChatProvider([
      { text: JSON.stringify({ body: firstRewrittenBody }), toolCalls: [] },
    ])

    const graphStateBefore = await readGraph(paths)
    const firstNarratives = await resolveNarratives(paths, graphStateBefore, firstOut, firstChat, 'fake-model')
    expect(firstNarratives.get('arc_health')).toBe(firstRewrittenBody)

    await applyReflection(paths, firstOut, sessionId, [], now, firstNarratives)

    const afterFirst = await readDocument(arcDocPath)
    expect(afterFirst.body).toBe(firstRewrittenBody)

    // Second session, same arc. Pass two must see the body the first pass
    // actually left on disk, not the original seed body from beforeEach.
    const secondSessionId = newId('session')
    const secondSessionDir = join(paths.sessionsDir, `2026-08-14-${secondSessionId}`)
    await mkdir(secondSessionDir, { recursive: true })

    const secondOut: ReflectionOutput = {
      ...emptyReflectionOutput('Second session: ran again, longer this time.'),
      items: [{ text: 'Went for a 10k run', kind: 'event' }],
      attributions: [{ itemIndex: 0, arcId: 'arc_health', confidence: 0.9 }],
      arcUpdates: [{ arcId: 'arc_health', note: 'Ran a 10k, building on the 5k.' }],
    }
    const secondRewrittenBody =
      'Training log:\n- Ran a 5k to start marathon training.\n- Ran a 10k, building on the 5k.\n'
    const secondChat = new FakeChatProvider([
      { text: JSON.stringify({ body: secondRewrittenBody }), toolCalls: [] },
    ])

    const graphStateSecond = await readGraph(paths)
    const secondNarratives = await resolveNarratives(paths, graphStateSecond, secondOut, secondChat, 'fake-model')

    const secondPrompt = secondChat.requests[0]?.messages[0]?.content ?? ''
    expect(secondPrompt).toContain('Ran a 5k to start marathon training')

    await applyReflection(paths, secondOut, secondSessionId, [], now, secondNarratives)

    const afterSecond = await readDocument(arcDocPath)
    expect(afterSecond.body).toBe(secondRewrittenBody)
    expect(afterSecond.body).toContain('Ran a 5k to start marathon training')
    expect(afterSecond.body).toContain('Ran a 10k, building on the 5k')
  })

  it('a pass-two failure leaves the existing document byte for byte unchanged', async () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session that tries and fails to update the arc.'),
      arcUpdates: [{ arcId: 'arc_health', note: 'Something happened.' }],
    }
    const chat = new FakeChatProvider([
      { text: 'not json', toolCalls: [] },
      { text: 'still not json', toolCalls: [] },
    ])

    const before = await readDocument(arcDocPath)

    const graphState = await readGraph(paths)
    const narratives = await resolveNarratives(paths, graphState, out, chat, 'fake-model')
    expect(narratives.has('arc_health')).toBe(false)

    await applyReflection(paths, out, sessionId, [], now, narratives)

    const after = await readDocument(arcDocPath)
    expect(after.body).toBe(before.body)
    expect(after.meta.updated).toBeUndefined()
  })
})
```

This is the test whose absence hid the original defect: every prior test asserted the arc body equals the fresh narrative, never that a second pass preserves the first.

- [ ] **Step 17: Run the test to verify it fails**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts -t "narrative continuity across sessions"`
Expected: without Steps 1-15 landed this fails with `ReferenceError: resolveNarratives is not defined`; with them landed (this is the real regression check) it should already PASS, proving the fix. Run it once before Step 15's commit lands to confirm it is exercising real behavior, not a tautology: temporarily revert Step 13's narrative-writing addition and confirm this test then fails with the second body missing the first line, then restore Step 13.

- [ ] **Step 18: Confirm passing and commit**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts`
Expected: PASS.

```bash
git add packages/memory/src/reflection.test.ts
git commit -m "$(cat <<'EOF'
Add the narrative continuity test that would have caught the overwrite bug

Two consecutive reflections over the same arc: the second body must still
carry what the first established, and a failed pass two must leave the
existing document untouched.
EOF
)"
```

- [ ] **Step 19: Wire pass two into the engine and reindex whatever it rewrites**

```ts
// engine.ts, _doEndSession, replacing the applyReflection call and the block after it
const narratives = await resolveNarratives(
  this.paths,
  this.graphState,
  out,
  this.deps.chat,
  this.deps.reflectionModel,
)
const result = await applyReflection(this.paths, out, sessionId, liveItems, now, narratives)
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
```

Import `resolveNarratives` alongside the existing `applyReflection`/`reflectSession` import.

- [ ] **Step 20: Run the full engine test suite to verify nothing broke**

Run: `pnpm vitest run packages/memory/src/engine.test.ts`
Expected: PASS. The existing lifecycle test still passes with `arcNarratives: []` gone from the fixture (Task 4 already updated it) since it sets no `arcUpdates`, so `resolveNarratives` returns an empty map and behavior is unchanged.

- [ ] **Step 21: Commit**

```bash
git add packages/memory/src/engine.ts
git commit -m "$(cat <<'EOF'
Run pass two between reflectSession and applyReflection in the engine

applyReflection stays deterministic; the engine owns the model call that
decides what pass two actually rewrites, and reindexes whatever lands on disk.
EOF
)"
```

---

### Task 6: save by default

**Files:**
- Modify: `packages/memory/src/reflection.ts:34` (`CONFIDENCE_THRESHOLD` removed), `:242-259` (`resolveItemIds` exported), `:267-` (`applyReflection`: attribution loop always asserts, `newArcs`/`newPersons` proposal loops removed, `mintedItems` added to the return, `proposals`/`droppedProposals` removed from the return), dead helpers `newArcProposalSummary`, `newPersonProposalSummary`, `linkProposalSummary` removed
- Modify: `packages/memory/src/engine.ts:577-660` (`materializeProposal`'s `new_arc`/`new_person` branches call new shared methods), new private `createArc`, new private `createPersonPage` (renaming and extending the `writePersonPage` method added earlier), `:185-242` (`_doEndSession`: direct materialization of `newArcs`/`newPersons` after `applyReflection` returns)
- Test: `packages/memory/src/reflection.test.ts` (rewrite the main `applyReflection` test, delete the `CONFIDENCE_THRESHOLD` test and the non-arc link-proposal test, delete the dropped-proposals-for-new-arcs/persons assertions, add a "nothing appended to proposals.jsonl" test)
- Test: `packages/memory/src/engine.test.ts` (add: reflection alone produces an arc, reflection alone produces a person page, a pre-existing pending proposal still resolves end to end)

**Interfaces:**
- Consumes: `resolveItemIds` (now exported from `reflection.ts`), `MemoryEngine.createArc`, `MemoryEngine.createPersonPage`
- Produces:
  ```ts
  export function resolveItemIds(indexes: number[], mintedItems: ReflectionItem[]): string[]

  export async function applyReflection(
    paths: MemoryPaths,
    out: ReflectionOutput,
    sessionId: string,
    liveItems: ReflectionItem[],
    now: Date,
    narratives: Map<string, string>,
  ): Promise<{ summaryDoc: Document; autoAsserted: number; mintedItems: ReflectionItem[] }>
  ```
  ```ts
  // engine.ts, both new and both called from materializeProposal and _doEndSession
  private async createArc(input: {
    name: string
    realm: string
    itemIds: string[]
    narrative: string
    source: string
  }): Promise<GraphNode>

  private async createPersonPage(input: {
    name: string
    itemIds: string[]
    narrative: string
    source: string
  }): Promise<GraphNode>
  ```

- [ ] **Step 1: Write the failing test for save-by-default attribution and no proposals**

```ts
// packages/memory/src/reflection.test.ts, replacing the body of the main applyReflection test
it('writes the summary and asserts every attribution as a part_of edge, appending nothing to proposals.jsonl', async () => {
  const out: ReflectionOutput = {
    summary: 'Talked about a morning run and an upcoming deadline.',
    items: [
      { text: 'Went for a long run', kind: 'event' },
      { text: 'Feeling anxious about a work deadline', kind: 'feeling' },
    ],
    attributions: [
      { itemIndex: 0, arcId: 'arc_health', confidence: 0.9 },
      { itemIndex: 1, arcId: 'arc_unknown', confidence: 0.3 },
    ],
    newArcs: [],
    newPersons: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
  }

  const result = await applyReflection(paths, out, sessionId, [], now, new Map())

  const runItem = result.mintedItems[0]
  const deadlineItem = result.mintedItems[1]
  if (!runItem || !deadlineItem) throw new Error('expected two minted items')

  const graph = await readGraph(paths)
  expect(graph.edges.get(`part_of:${runItem.id}:arc_health`)).toMatchObject({
    confidence: 0.9,
    confirmed: false,
  })
  // Low confidence no longer routes to a proposal; it is asserted too,
  // even though arc_unknown does not resolve to any real node.
  expect(graph.edges.get(`part_of:${deadlineItem.id}:arc_unknown`)).toMatchObject({
    confidence: 0.3,
    confirmed: false,
  })
  expect(result.autoAsserted).toBe(2)

  const pending = await pendingProposals(paths)
  expect(pending).toHaveLength(0)
  await expect(readFile(paths.proposals, 'utf8')).rejects.toThrow()
})

it('appends nothing to proposals.jsonl even for a session with new arcs and persons', async () => {
  const out: ReflectionOutput = {
    ...emptyReflectionOutput('A session with new things to remember.'),
    items: [{ text: 'Went for a long run', kind: 'event' }],
    newArcs: [
      {
        name: 'marathon training',
        realm: 'realm_health',
        reason: 'mentioned running multiple times',
        itemIndexes: [0],
        narrative: 'Training for a marathon this fall.',
      },
    ],
    newPersons: [
      { name: 'Sam', reason: 'running partner', itemIndexes: [0], narrative: 'Sam runs with them.' },
    ],
  }

  await applyReflection(paths, out, sessionId, [], now, new Map())

  const pending = await pendingProposals(paths)
  expect(pending).toHaveLength(0)
  await expect(readFile(paths.proposals, 'utf8')).rejects.toThrow()
})
```

Add `readFile` to the `node:fs/promises` import at the top of the file. Delete the test `'CONFIDENCE_THRESHOLD is 0.8'`, the test `'routes an attribution to an existing non-arc node into a link proposal, not an edge'`, and the test `'dedupes and bounds-checks itemIndexes, dropping any proposal that resolves to no items'` (the drop behavior for `newArcs`/`newPersons` moves to the engine's direct-materialization call sites in Step 9).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts -t "asserts every attribution as a part_of edge"`
Expected: FAIL. `result.mintedItems` is `undefined` (not yet returned), and the low-confidence attribution is still routed to a proposal instead of an edge.

- [ ] **Step 3: Simplify applyReflection's attribution handling and remove proposal creation**

```ts
// reflection.ts, replacing the attribution loop and the newArcs/newPersons loops
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
// below. applyReflection itself never creates a proposal for them.
```

Remove `linkProposalSummary`, `newArcProposalSummary`, `newPersonProposalSummary`, the `Proposal`/`appendProposals` import, and the `const proposals: Proposal[] = []` / `droppedProposals` bookkeeping. Update the function signature and return:

```ts
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
  // ...
  await appendGraph(paths, graphRecords)

  for (const write of narrativeWrites) {
    await writeDocumentAtomic(write)
  }
  if (constitutionWrite) {
    await writeDocumentAtomic(constitutionWrite)
  }

  await writeDocumentAtomic({
    path: summaryPath,
    meta: { id: newId('doc'), kind: 'summary', session: sessionId, date, items: mergedItems },
    body: out.summary,
  })
  const summaryDoc = await readDocument(summaryPath)

  return { summaryDoc, autoAsserted, mintedItems }
}
```

Also remove `export const CONFIDENCE_THRESHOLD = 0.8` from the top of the file: no branch reads it any more.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/memory/src/reflection.test.ts`
Expected: PASS. `emptyReflectionOutput` still returns the Task 4/5 shape; no test in the file references `CONFIDENCE_THRESHOLD`, `proposals`, or `droppedProposals` on `applyReflection`'s result any more.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/reflection.ts packages/memory/src/reflection.test.ts
git commit -m "$(cat <<'EOF'
Assert every attribution directly and stop queuing proposals from applyReflection

Every attribution becomes a part_of edge carrying the model's confidence,
whatever it is. Reflection no longer writes to proposals.jsonl at all.
EOF
)"
```

- [ ] **Step 6: Export resolveItemIds**

```ts
// reflection.ts
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
```

No test needed for this step in isolation; it is exercised end to end by the engine tests in Step 11. Add the `export` keyword and run the existing suite once to confirm nothing else in the file breaks: `pnpm vitest run packages/memory/src/reflection.test.ts`, expect PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/reflection.ts
git commit -m "Export resolveItemIds so the engine can reuse it for direct materialization"
```

- [ ] **Step 8: Write the failing test for createArc, exercised through resolveProposal (existing materializeProposal path must keep working)**

```ts
// packages/memory/src/engine.test.ts, inside describe('resolveProposal materialization'):
// this test already exists ('materializes a new arc together with a brand-new realm...');
// run it now to establish the baseline it must keep passing after the extraction.
```

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "materializes a new arc together with a brand-new realm"`
Expected at this point: PASS (unchanged code). This step is a checkpoint, not a new test: the refactor in Step 9 must not break it.

- [ ] **Step 9: Extract createArc and createPersonPage, and call them from materializeProposal**

```ts
// engine.ts, new private methods, placed near resolveOrCreateRealm
private async createArc(input: {
  name: string
  realm: string
  itemIds: string[]
  narrative: string
  source: string
}): Promise<GraphNode> {
  const now = new Date()
  const nowIso = now.toISOString()
  const realmNodeId = await this.resolveOrCreateRealm(input.realm, nowIso)

  const arcNodeId = newId('arc')
  const slug = await uniqueSlug(this.paths.arcsDir, input.name)
  const arcPath = join(this.paths.arcsDir, `${slug}.md`)
  const arcDoc: Document = {
    path: arcPath,
    meta: {
      id: newId('doc'),
      name: input.name,
      status: 'active',
      realm: realmNodeId,
      opened: nowIso,
    },
    body: input.narrative.length > 0 ? input.narrative : ARC_STARTER_BODY,
  }
  await writeDocumentAtomic(arcDoc)

  const records: GraphRecord[] = [
    { ts: nowIso, op: 'assert', node: arcNodeId, type: 'arc', label: input.name, doc: arcPath },
    {
      ts: nowIso,
      op: 'assert',
      edge: 'in',
      from: arcNodeId,
      to: realmNodeId,
      confidence: 1,
      confirmed: true,
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
      confirmed: true,
      source: input.source,
    })
  }
  await appendGraph(this.paths, records)
  await this.syncGraph()
  await this.reindexDocument(await readDocument(arcPath), 'arc')
  const node = this.graphState.nodes.get(arcNodeId)
  if (!node) throw new Error(`createArc: arc node ${arcNodeId} missing from graph state after assert.`)
  return node
}

private async createPersonPage(input: {
  name: string
  itemIds: string[]
  narrative: string
  source: string
}): Promise<GraphNode> {
  const now = new Date()
  const nowIso = now.toISOString()

  const personNodeId = newId('person')
  const slug = await uniqueSlug(this.paths.peopleDir, input.name)
  const personPath = join(this.paths.peopleDir, `${slug}.md`)
  const personDoc: Document = {
    path: personPath,
    meta: { id: newId('doc'), name: input.name, node: personNodeId, opened: nowIso },
    body: input.narrative.length > 0 ? input.narrative : PERSON_STARTER_BODY,
  }
  await writeDocumentAtomic(personDoc)

  const records: GraphRecord[] = [
    { ts: nowIso, op: 'assert', node: personNodeId, type: 'person', label: input.name, doc: personPath },
  ]
  for (const itemId of input.itemIds) {
    records.push({
      ts: nowIso,
      op: 'assert',
      edge: 'involves',
      from: itemId,
      to: personNodeId,
      confidence: 1,
      confirmed: true,
      source: input.source,
    })
  }
  await appendGraph(this.paths, records)
  await this.syncGraph()
  await this.reindexDocument(await readDocument(personPath), 'person')
  const node = this.graphState.nodes.get(personNodeId)
  if (!node) throw new Error(`createPersonPage: person node ${personNodeId} missing from graph state after assert.`)
  return node
}
```

This replaces the earlier `writePersonPage(name, nowIso)` method added for proposal-only creation: `createPersonPage` folds in the involves-edge creation that used to happen separately in `materializeProposal`'s `new_person` branch, so there is exactly one place that writes a person page.

```ts
// engine.ts, materializeProposal: replace the new_arc branch
if (proposal.kind === 'new_arc') {
  const payload = proposal.payload as { name: string; realm: string; itemIds: string[] }
  await this.createArc({
    name: payload.name,
    realm: payload.realm,
    itemIds: payload.itemIds,
    narrative: '',
    source: proposal.source,
  })
  return
}
```

```ts
// engine.ts, materializeProposal: replace the new_person branch
if (proposal.kind === 'new_person') {
  const payload = proposal.payload as { name: string; itemIds: string[] }
  await this.createPersonPage({
    name: payload.name,
    itemIds: payload.itemIds,
    narrative: '',
    source: proposal.source,
  })
  return
}
```

- [ ] **Step 10: Run the checkpoint test to verify it still passes**

Run: `pnpm vitest run packages/memory/src/engine.test.ts`
Expected: PASS, including the pre-existing `'materializes a new arc together with a brand-new realm...'` and any Task-2-added person-proposal test: `createArc`/`createPersonPage` reproduce the exact same document and graph writes as before, just under a shared name.

- [ ] **Step 11: Commit**

```bash
git add packages/memory/src/engine.ts
git commit -m "$(cat <<'EOF'
Extract createArc and createPersonPage as shared MemoryEngine methods

materializeProposal now calls the same two methods the next commit wires up
for direct materialization during reflection, instead of duplicating the
arc and person creation logic.
EOF
)"
```

- [ ] **Step 12: Write the failing tests for direct materialization and legacy proposal compatibility**

```ts
// packages/memory/src/engine.test.ts, new describe block
describe('reflection materializes directly, proposals stay dormant', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-save-by-default-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('materializes a new arc directly during reflection with no proposal and no acceptance step', async () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('Started training for a marathon.'),
      items: [{ text: 'Went for a long run', kind: 'event' }],
      newArcs: [
        {
          name: 'Marathon Training',
          realm: 'Fitness',
          reason: 'mentioned training for a marathon',
          itemIndexes: [0],
          narrative: 'Training for a marathon this fall, starting with long weekend runs.',
        },
      ],
    }
    const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))

    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'Went for a long run, training for a marathon this fall.',
    })
    await engine.endSession(sessionId)

    const graph = await readGraph(paths)
    const arcNode = [...graph.nodes.values()].find(
      (n) => n.type === 'arc' && n.label === 'Marathon Training',
    )
    if (!arcNode?.doc) throw new Error('expected an arc node with a doc pointer')

    const arcDoc = await readDocument(arcNode.doc)
    expect(arcDoc.body).toBe('Training for a marathon this fall, starting with long weekend runs.\n')
    expect(arcDoc.meta.status).toBe('active')

    const pending = await pendingProposals(paths)
    expect(pending).toHaveLength(0)

    await engine.close()
  })

  it('materializes a person page directly during reflection with no proposal and no acceptance step', async () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('Talked a lot about Sam today.'),
      items: [{ text: 'Ran with Sam again', kind: 'event' }],
      newPersons: [
        {
          name: 'Sam',
          reason: 'recurring running partner, mentioned again this session',
          itemIndexes: [0],
          narrative: 'Sam is a running partner who joins for weekend long runs.',
        },
      ],
    }
    const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))

    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'Ran with Sam again this morning.',
    })
    await engine.endSession(sessionId)

    const graph = await readGraph(paths)
    const personNode = [...graph.nodes.values()].find(
      (n) => n.type === 'person' && n.label === 'Sam',
    )
    if (!personNode?.doc) throw new Error('expected a person node with a doc pointer')

    const personDoc = await readDocument(personNode.doc)
    expect(personDoc.body).toBe('Sam is a running partner who joins for weekend long runs.\n')
    expect(personDoc.meta.name).toBe('Sam')
    expect(personDoc.meta.node).toBe(personNode.id)

    const pending = await pendingProposals(paths)
    expect(pending).toHaveLength(0)

    await engine.close()
  })

  it('drops a newArcs entry whose itemIndexes resolve to no items, materializing nothing for it', async () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A session with a ghost arc.'),
      newArcs: [
        {
          name: 'Ghost Arc',
          realm: 'Fitness',
          reason: 'only out-of-range indexes',
          itemIndexes: [5, -1],
          narrative: 'Should never land anywhere.',
        },
      ],
    }
    const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))

    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'A session with nothing much in it.',
    })
    await engine.endSession(sessionId)

    const graph = await readGraph(paths)
    expect([...graph.nodes.values()].some((n) => n.label === 'Ghost Arc')).toBe(false)

    await engine.close()
  })

  it('a pre-existing pending proposal still surfaces in sessionContext and still resolves end to end', async () => {
    const proposal: Proposal = {
      id: newId('prop'),
      ts: new Date().toISOString(),
      kind: 'new_arc',
      summary: 'A proposal that predates this release.',
      payload: { name: 'Legacy Arc', realm: 'Legacy Realm', itemIds: [newId('item')] },
      source: 'session_legacy',
    }
    await appendProposals(paths, [proposal])

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

    const context = await engine.sessionContext()
    expect(context.pendingProposals.map((p) => p.id)).toContain(proposal.id)

    await engine.resolveProposal(proposal.id, 'accepted')

    const graph = await readGraph(paths)
    const arcNode = [...graph.nodes.values()].find(
      (n) => n.type === 'arc' && n.label === 'Legacy Arc',
    )
    expect(arcNode).toBeDefined()

    const pending = await pendingProposals(paths)
    expect(pending.find((p) => p.id === proposal.id)).toBeUndefined()

    await engine.close()
  })

  it('a reflection run appends nothing to proposals.jsonl even with new arcs, new persons, and low-confidence attributions', async () => {
    const out: ReflectionOutput = {
      ...emptyReflectionOutput('A busy session.'),
      items: [{ text: 'Went for a long run', kind: 'event' }],
      attributions: [{ itemIndex: 0, arcId: 'arc_does_not_exist', confidence: 0.1 }],
      newArcs: [
        {
          name: 'Marathon Training',
          realm: 'Fitness',
          reason: 'mentioned training',
          itemIndexes: [0],
          narrative: 'First body.',
        },
      ],
    }
    const chat = new FakeChatProvider([{ text: JSON.stringify(out), toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))

    const sessionId = await engine.startSession()
    await engine.appendTranscript(sessionId, {
      ts: new Date().toISOString(),
      role: 'user',
      content: 'A busy session about running.',
    })
    await engine.endSession(sessionId)

    await expect(readFile(paths.proposals, 'utf8')).rejects.toThrow()

    await engine.close()
  })
})
```

Add `Proposal`, `appendProposals`, `pendingProposals`, `newId`, `readGraph`, `appendGraph`, `readFile` to `engine.test.ts`'s existing imports where not already present (most already are; `readFile` from `node:fs/promises` is new).

- [ ] **Step 13: Run the tests to verify they fail**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "reflection materializes directly, proposals stay dormant"`
Expected: FAIL. `_doEndSession` still only calls `applyReflection` and does nothing with `out.newArcs`/`out.newPersons`, so no arc or person node is ever created and the two "materializes... directly" tests find no matching node.

- [ ] **Step 14: Wire direct materialization into _doEndSession**

```ts
// engine.ts, _doEndSession, after the narrative reindex loop added in Task 5's Step 19
for (const arc of out.newArcs) {
  const itemIds = resolveItemIds(arc.itemIndexes, result.mintedItems)
  if (itemIds.length === 0) {
    continue
  }
  await this.createArc({
    name: arc.name,
    realm: arc.realm,
    itemIds,
    narrative: arc.narrative,
    source: sessionId,
  })
}
for (const person of out.newPersons) {
  const itemIds = resolveItemIds(person.itemIndexes, result.mintedItems)
  if (itemIds.length === 0) {
    continue
  }
  await this.createPersonPage({
    name: person.name,
    itemIds,
    narrative: person.narrative,
    source: sessionId,
  })
}
```

`createArc` and `createPersonPage` already call `this.syncGraph()` internally, so `this.graphState` is current for the commit step that follows. Import `resolveItemIds` from `./reflection.js` alongside the other reflection imports.

- [ ] **Step 15: Run the tests to verify they pass**

Run: `pnpm vitest run packages/memory/src/engine.test.ts`
Expected: PASS, all tests in the file green, including every test in the new describe block and every pre-existing `resolveProposal materialization` test unchanged.

- [ ] **Step 16: Run the whole memory package suite once**

Run: `pnpm vitest run packages/memory/src`
Expected: PASS. This is the final check that Tasks 4, 5, and 6 together leave `reflection.ts` and `engine.ts` internally consistent: no remaining reference to `arcNarratives`, `CONFIDENCE_THRESHOLD`, or proposal creation inside `applyReflection`, and `people/`, pass two, and direct materialization all exercised together in at least one full session lifecycle.

- [ ] **Step 17: Commit**

```bash
git add packages/memory/src/engine.ts packages/memory/src/engine.test.ts
git commit -m "$(cat <<'EOF'
Materialize new arcs and persons directly during reflection

Reflection no longer proposes; it saves. newArcs and newPersons become real
arc and person documents the same session they are noticed, using the
itemIds applyReflection already minted. Pre-existing pending proposals in
older memory folders still surface and still resolve end to end; nothing
new is ever appended to proposals.jsonl.
EOF
)"
```

---

### Task 7: the forget tool

**Files:**
- Modify: `packages/memory/src/engine.ts` (new `ForgetInput`/`ForgetResult` types near `GraphQuery` at line 81-85; new `forget()` method inserted after `resolveProposal` (currently line 371-385), before `runMaintenance`; new private `kindForDocumentPath` helper near the other private helpers, after `reindexOrWarn` (currently line 522-531); add `edgeKey` to the `./graph.js` import at line 25-32)
- Test: `packages/memory/src/engine.test.ts` (new `describe('forget', ...)` block inside `describe('MemoryEngine', ...)`; add `readFile` to the `node:fs/promises` import at line 2)
- Modify: `packages/core/src/tools.ts` (new `forgetArgs` schema after `updateStyleArgs` at line 71; new tool entry in `toolDefinitions()` after `update_style` at line 276; new `case 'forget':` in the `dispatchTool` switch at line 310; new `dispatchForget` function after `dispatchUpdateStyle` at line 429)
- Test: `packages/core/src/tools.test.ts` (edit the `toolDefinitions` "lists exactly the nine..." test at line 64-84 to ten tools including `forget`; two new `it` blocks in `describe('dispatchTool', ...)`)
- Modify: `packages/cli/src/chat.ts` (add `forget: 'forgetting',` to `TOOL_NOTICES` at line 65-75)
- Test: `packages/cli/src/chat.test.ts` (extend the `describe('toolNotice', ...)` block at line 563-578)
- Modify: `packages/core/src/personas.ts` (new `FORGET_INSTRUCTION` constant after `PENDING_PROPOSALS` at line 20; add it to the `sections` array in `buildPersona` at line 119-127)
- Test: `packages/core/src/personas.test.ts` (new `it` block in `describe('buildPersona', ...)`)

Note: no change to `packages/memory/src/graph.ts`. `op: 'retract'` already exists in the schema and `foldGraph` already handles it correctly (graph.ts:101, graph.ts:116). Nothing in production code has ever emitted one until this task.

**Interfaces:**
- Consumes: `MemoryPaths.peopleDir`, `MemoryEngine`'s private `docPaths: Map<string, string>` and `graphState: GraphState`, `writeDocumentAtomic(doc: Document): Promise<void>`, `readDocument(path: string): Promise<Document>`, `appendGraph(paths, records: GraphRecord[]): Promise<void>`, `edgeKey(e: { edge: EdgeType; from: string; to: string }): string`, `commitMemory(root: string, message: string): Promise<CommitResult>`, `DocKind` from `./sqlite.js`
- Produces:
  ```ts
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
  // MemoryEngine
  async forget(input: ForgetInput): Promise<ForgetResult>
  // tools.ts
  export function toolDefinitions(): ToolDefinition[] // now includes 'forget'
  // chat.ts
  export function toolNotice(name: string): string // toolNotice('forget') === '[forgetting]'
  ```

- [ ] **Step 1: Write the failing tests for `MemoryEngine.forget`**

Edit the top of `packages/memory/src/engine.test.ts` to add `readFile`:

```ts
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listDocuments, newId, readDocument, writeDocumentAtomic } from './documents.js'
import { type EngineDeps, MemoryEngine } from './engine.js'
import { appendGraph, readGraph } from './graph.js'
import { ensureMemoryTree, type MemoryPaths, memoryPaths } from './paths.js'
import { appendProposals, type Proposal, pendingProposals } from './proposals.js'
import { applyReflection, type ReflectionItem, type ReflectionOutput } from './reflection.js'
import { SessionStore } from './transcripts.js'
```

Add this new describe block inside `describe('MemoryEngine', ...)`, as a sibling of `describe('full session lifecycle', ...)`:

```ts
  describe('forget', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-forget-'))
      paths = memoryPaths(dir)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('retracts requested nodes and edges: foldGraph drops them, and the tool reports what actually changed', async () => {
      await ensureMemoryTree(paths)
      await appendGraph(paths, [
        { ts: '2026-08-01T00:00:00.000Z', op: 'assert', node: 'person_x', type: 'person', label: 'Alex' },
        { ts: '2026-08-01T00:00:00.000Z', op: 'assert', node: 'item_x', type: 'item', label: 'A note' },
        {
          ts: '2026-08-01T00:00:01.000Z',
          op: 'assert',
          edge: 'involves',
          from: 'item_x',
          to: 'person_x',
          confidence: 0.8,
          confirmed: false,
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const result = await engine.forget({
        what: 'a person who does not belong in this record',
        nodeIds: ['person_x'],
        edges: [{ edge: 'involves', from: 'item_x', to: 'person_x' }],
      })

      expect(result).toEqual({ retractedNodes: 1, retractedEdges: 1, rewrittenDocuments: [] })

      const state = await readGraph(paths)
      expect(state.nodes.has('person_x')).toBe(false)
      expect(state.edges.has('involves:item_x:person_x')).toBe(false)

      await engine.close()
    })

    it('preserves history: the original assert lines stay in graph.jsonl alongside the new retract lines', async () => {
      await ensureMemoryTree(paths)
      await appendGraph(paths, [
        { ts: '2026-08-01T00:00:00.000Z', op: 'assert', node: 'person_y', type: 'person', label: 'Sam' },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      await engine.forget({ what: 'a contact who moved away', nodeIds: ['person_y'] })

      const raw = await readFile(paths.graphLog, 'utf8')
      const records = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { node?: string; op: string })
      const forPersonY = records.filter((r) => r.node === 'person_y')
      expect(forPersonY.map((r) => r.op)).toEqual(['assert', 'retract'])

      await engine.close()
    })

    it('rejects a document rewrite with an empty or whitespace-only body, changing nothing on disk', async () => {
      await ensureMemoryTree(paths)
      const docId = newId('doc')
      const docPath = join(paths.arcsDir, 'marathon.md')
      await writeDocumentAtomic({
        path: docPath,
        meta: { id: docId, name: 'Marathon training', status: 'active' },
        body: 'Training for the spring marathon.\n',
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      await expect(
        engine.forget({ what: 'the marathon plan', documents: [{ docId, body: '   \n  ' }] }),
      ).rejects.toThrow(/empty|whitespace/)

      const stillThere = await readDocument(docPath)
      expect(stillThere.body).toBe('Training for the spring marathon.\n')

      await engine.close()
    })

    it('rewrites a document atomically when the new body is real content', async () => {
      await ensureMemoryTree(paths)
      const docId = newId('doc')
      const docPath = join(paths.arcsDir, 'marathon.md')
      await writeDocumentAtomic({
        path: docPath,
        meta: { id: docId, name: 'Marathon training', status: 'active' },
        body: 'Training for the spring marathon, with a friend named Alex.\n',
      })

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const result = await engine.forget({
        what: "Alex's name out of the marathon arc",
        documents: [{ docId, body: 'Training for the spring marathon.\n' }],
      })

      expect(result.rewrittenDocuments).toEqual([docPath])
      const rewritten = await readDocument(docPath)
      expect(rewritten.body).toBe('Training for the spring marathon.\n')

      await engine.close()
    })

    it('never writes to a transcript or a session summary', async () => {
      await ensureMemoryTree(paths)
      await appendGraph(paths, [
        { ts: '2026-08-01T00:00:00.000Z', op: 'assert', node: 'person_z', type: 'person', label: 'Jo' },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
      const startedAt = new Date()
      const sessionId = await engine.startSession(startedAt)
      await engine.appendTranscript(sessionId, {
        ts: startedAt.toISOString(),
        role: 'user',
        content: 'Jo and I had a falling out.',
      })

      const sessionDir = join(paths.sessionsDir, `${isoDate(startedAt)}-${sessionId}`)
      const transcriptPath = join(sessionDir, 'transcript.jsonl')
      const before = await readFile(transcriptPath, 'utf8')

      await engine.forget({ what: 'the falling out with Jo', nodeIds: ['person_z'] })

      const after = await readFile(transcriptPath, 'utf8')
      expect(after).toBe(before)
      await expect(readDocument(join(sessionDir, 'summary.md'))).rejects.toThrow()

      await engine.close()
    })

    it('commits the change with message "forget: <what>"', async () => {
      await ensureMemoryTree(paths)
      await appendGraph(paths, [
        { ts: '2026-08-01T00:00:00.000Z', op: 'assert', node: 'person_w', type: 'person', label: 'Pat' },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))

      await engine.forget({ what: 'an old contact named Pat', nodeIds: ['person_w'] })

      const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: dir })
      expect(stdout.trim()).toBe('forget: an old contact named Pat')

      await engine.close()
    })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "forget"`
Expected: FAIL. Every test throws `TypeError: engine.forget is not a function`, since `MemoryEngine` has no `forget` method yet.

- [ ] **Step 3: Implement `MemoryEngine.forget`**

In `packages/memory/src/engine.ts`, widen the `./graph.js` import:

```ts
import {
  appendGraph,
  edgeKey,
  type EdgeType,
  type GraphNode,
  type GraphRecord,
  type GraphState,
  readGraph,
} from './graph.js'
```

Add these two exported interfaces near `GraphQuery`:

```ts
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
```

Add the method to the `MemoryEngine` class, right after `resolveProposal`:

```ts
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
```

Add the private helper near `reindexOrWarn`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "forget"`
Expected: PASS, all six tests.

- [ ] **Step 5: Commit**

Commit message: `memory: add MemoryEngine.forget for node, edge, and document retraction`

- [ ] **Step 6: Write the failing tests for the `forget` tool in core**

Edit the existing test in `packages/core/src/tools.test.ts`:

```ts
describe('toolDefinitions', () => {
  it('lists exactly the ten memory and style tools with non-empty descriptions and a JSON schema', () => {
    const defs = toolDefinitions()
    const names = defs.map((d) => d.name).sort()
    expect(names).toEqual(
      [
        'forget',
        'graph_query',
        'list_arcs',
        'list_realms',
        'read_document',
        'read_transcript',
        'remember',
        'resolve_proposal',
        'search_memory',
        'update_style',
      ].sort(),
    )
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(20)
      expect(def.parameters).toMatchObject({ type: 'object' })
    }
  })

  it('never uses an em dash in a tool description', () => {
    const emDash = String.fromCharCode(0x2014)
    for (const def of toolDefinitions()) {
      expect(def.description).not.toContain(emDash)
    }
  })
})
```

Add two new tests inside `describe('dispatchTool', ...)`, after the `update_style` describe block closes:

```ts
  describe('forget', () => {
    it('retracts a node and reports what actually changed', async () => {
      const paths = memoryPaths(dir)
      await MemoryEngine.open(dir, fakeDeps()).then((e) => e.close())

      await appendGraph(paths, [
        {
          ts: '2026-08-01T00:00:00.000Z',
          op: 'assert',
          node: 'person_d',
          type: 'person',
          label: 'Drew',
        },
      ])

      const engine = await MemoryEngine.open(dir, fakeDeps())
      const sessionId = await engine.startSession()

      const result = await dispatchTool(
        engine,
        sessionId,
        call('forget', { what: 'a person who does not belong here', nodeIds: ['person_d'] }),
      )
      expect(JSON.parse(result)).toEqual({
        ok: true,
        retractedNodes: 1,
        retractedEdges: 0,
        rewrittenDocuments: [],
      })

      await engine.close()
    })

    it('returns a JSON error, not a throw, when a document body would be empty', async () => {
      const paths = memoryPaths(dir)
      const docId = newId('doc')
      const docPath = join(paths.arcsDir, 'health.md')

      const engine = await MemoryEngine.open(dir, fakeDeps())
      await writeDocumentAtomic({
        path: docPath,
        meta: { id: docId, name: 'Health', status: 'active' },
        body: 'Original arc narrative.\n',
      })
      const sessionId = await engine.startSession()

      const result = await dispatchTool(
        engine,
        sessionId,
        call('forget', { what: 'the health narrative', documents: [{ docId, body: '  ' }] }),
      )
      expect(JSON.parse(result).error).toMatch(/empty|whitespace/)

      await engine.close()
    })
  })
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/tools.test.ts`
Expected: FAIL. The names test fails (`forget` missing from the list), and the two new `forget` tests fail with `unknown tool: forget`.

- [ ] **Step 8: Implement the `forget` tool in core**

In `packages/core/src/tools.ts`, add the arg schema after `updateStyleArgs`:

```ts
const forgetArgs = z.strictObject({
  what: z.string(),
  nodeIds: z.array(z.string()).optional(),
  edges: z
    .array(
      z.strictObject({
        edge: z.enum(['part_of', 'in', 'from', 'involves', 'relates_to']),
        from: z.string(),
        to: z.string(),
      }),
    )
    .optional(),
  documents: z.array(z.strictObject({ docId: z.string(), body: z.string() })).optional(),
})
```

Add a tool entry inside the array `toolDefinitions()` returns, after `update_style`:

```ts
    {
      name: 'forget',
      description:
        'Remove or correct something from the record: retract a node or edge from the graph, rewrite a ' +
        'document to no longer state something, or both, in one call. Use this only when the user has actually ' +
        'asked you to forget, remove, or correct something, never on your own judgment. Read a document first if ' +
        'you plan to rewrite it: the body you supply replaces it completely, and an empty or whitespace-only body ' +
        'is refused. This never touches the transcript of any conversation; transcripts are permanent and are ' +
        'never edited by this or any other tool.',
      parameters: {
        type: 'object',
        properties: {
          what: {
            type: 'string',
            description: 'A short, plain description of what is being forgotten. Used as the git commit message.',
          },
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of person, arc, or entity nodes to retract from the graph.',
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                edge: {
                  type: 'string',
                  enum: ['part_of', 'in', 'from', 'involves', 'relates_to'],
                },
                from: { type: 'string' },
                to: { type: 'string' },
              },
              required: ['edge', 'from', 'to'],
              additionalProperties: false,
            },
            description: 'Specific edges to retract, each naming the edge type and the two node ids it connects.',
          },
          documents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                docId: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['docId', 'body'],
              additionalProperties: false,
            },
            description:
              'Documents to rewrite in full, with the fact removed. The body you provide replaces the ' +
              'document completely; an empty or whitespace-only body is refused.',
          },
        },
        required: ['what'],
        additionalProperties: false,
      },
    },
```

Add the switch case in `dispatchTool`, after `update_style`:

```ts
      case 'forget':
        return await dispatchForget(engine, parsedArgs.value)
```

Add the dispatch function after `dispatchUpdateStyle`:

```ts
async function dispatchForget(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = forgetArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('forget', parsed.error))

  const result = await engine.forget(parsed.data)
  return JSON.stringify({ ok: true, ...result })
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/tools.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

Commit message: `core: add the forget tool, wired to MemoryEngine.forget`

- [ ] **Step 11: Write the failing test for the chat tool notice**

In `packages/cli/src/chat.test.ts`, edit the `describe('toolNotice', ...)` block:

```ts
describe('toolNotice', () => {
  it('maps each known tool to its honest, specific notice', () => {
    expect(toolNotice('remember')).toBe('[remembering]')
    expect(toolNotice('forget')).toBe('[forgetting]')
    expect(toolNotice('resolve_proposal')).toBe('[updating memory]')
    expect(toolNotice('update_style')).toBe('[adjusting style]')
    expect(toolNotice('search_memory')).toBe('[searching memory]')
    expect(toolNotice('read_document')).toBe('[reading memory]')
    expect(toolNotice('read_transcript')).toBe('[reading memory]')
    expect(toolNotice('graph_query')).toBe('[checking connections]')
    expect(toolNotice('list_arcs')).toBe('[checking memory]')
    expect(toolNotice('list_realms')).toBe('[checking memory]')
  })

  it('falls back to a plain, truthful notice for an unknown tool', () => {
    expect(toolNotice('some_future_tool')).toBe('[using: some_future_tool]')
  })
})
```

- [ ] **Step 12: Run the test to verify it fails**

Run: `pnpm vitest run packages/cli/src/chat.test.ts -t "toolNotice"`
Expected: FAIL. `toolNotice('forget')` returns `'[using: forget]'`, not `'[forgetting]'`.

- [ ] **Step 13: Implement the notice**

In `packages/cli/src/chat.ts`, edit `TOOL_NOTICES`:

```ts
const TOOL_NOTICES: Record<string, string> = {
  remember: 'remembering',
  forget: 'forgetting',
  resolve_proposal: 'updating memory',
  update_style: 'adjusting style',
  search_memory: 'searching memory',
  read_document: 'reading memory',
  read_transcript: 'reading memory',
  graph_query: 'checking connections',
  list_arcs: 'checking memory',
  list_realms: 'checking memory',
}
```

- [ ] **Step 14: Run the test to verify it passes**

Run: `pnpm vitest run packages/cli/src/chat.test.ts -t "toolNotice"`
Expected: PASS.

- [ ] **Step 15: Commit**

Commit message: `cli: give the forget tool an honest notice line`

- [ ] **Step 16: Write the failing test for the persona instruction**

In `packages/core/src/personas.test.ts`, add a new test inside `describe('buildPersona', ...)`:

```ts
  it('instructs using the forget tool and always saying the transcript itself is unchanged', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, resources, defaultStyle)
      expect(text.toLowerCase()).toContain('forget')
      expect(text.toLowerCase()).toMatch(/transcript[^.]*unchanged|unchanged[^.]*transcript/)
    }
  })
```

- [ ] **Step 17: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/personas.test.ts -t "forget tool"`
Expected: FAIL. Neither mode's persona text mentions forget or an unchanged transcript yet.

- [ ] **Step 18: Implement the persona instruction**

In `packages/core/src/personas.ts`, add the constant after `PENDING_PROPOSALS`:

```ts
const FORGET_INSTRUCTION = `When the user asks you to forget, remove, or correct something you have recorded about them, use the forget tool and actually do it, rather than only promising to. Once it runs, tell them plainly and specifically what was removed or changed. Every time you do this, also say clearly that the transcript of this conversation, and of every past conversation, is unchanged: you never edit or delete a transcript, so the record of what was actually said still exists exactly as it was, even though what you carry forward from it has changed.`
```

Add it to the `sections` array in `buildPersona`:

```ts
export function buildPersona(
  mode: PersonaMode,
  resources: CrisisResource[],
  style: StyleConfig,
): string {
  const sections = [
    WHAT_REVERIE_IS,
    RETRIEVE_BEFORE_ASSERTING,
    PENDING_PROPOSALS,
    FORGET_INSTRUCTION,
    CONVERSATIONAL_VOICE,
    styleSection(style),
    crisisSection(mode, resources),
  ]
  return sections.join('\n\n')
}
```

- [ ] **Step 19: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/personas.test.ts`
Expected: PASS, including the pre-existing shared-prefix and companion/firewall tests (the new section is identical in both modes, so it does not affect them).

- [ ] **Step 20: Commit**

Commit message: `core: instruct reverie to use forget and always name the transcript as unchanged`

---

### Task 8: the `reverie read` subcommand

**Files:**
- Create: `packages/cli/src/colors.ts`
- Test: Create `packages/cli/src/read.test.ts`
- Create: `packages/cli/src/read.ts`
- Modify: `packages/cli/src/chat.ts` (remove the ANSI constants, `colorize`, `dim`, `cyan`, and `magenta`; import them from `./colors.js` instead; `toolNotice` and everything else stays)
- Modify: `packages/cli/src/chat.test.ts` (the `describe('color helpers', ...)` block now imports `cyan` and `magenta` from `./colors.js` instead of `./chat.js`)
- Modify: `packages/cli/src/index.ts` (new `read` dispatch branch inserted before the `openCliContext` call at line 106, and the header comment at lines 4-7 updated to list it)

**Interfaces:**
- Consumes: `loadConfig(configPath?: string): Promise<ReverieConfig>`, `memoryPaths(root: string): MemoryPaths`, `listDocuments(dir, onSkip?): Promise<Document[]>`, `readDocument(path: string): Promise<Document>`, `magenta(text: string, enabled: boolean): string` (from the new `./colors.js`, not `./chat.js`, so this command never pulls in the memory package or better-sqlite3)
- Produces:
  ```ts
  export interface ReadDeps {
    loadConfig: () => Promise<ReverieConfig>
    write: (text: string) => void
    colorEnabled: boolean
  }
  export async function runRead(args: string[], deps: ReadDeps): Promise<number>
  // colors.ts
  export function dim(text: string, enabled?: boolean): string
  export function cyan(text: string, enabled: boolean): string
  export function magenta(text: string, enabled: boolean): string
  ```

### Why this path never opens the engine

`MemoryEngine.open()` unconditionally runs `runMaintenance()` (engine.ts:132), which can fire live reflection and embedding calls, and constructing either provider requires a resolvable API key. Reading your own record must work with the provider offline or unconfigured, so `runRead` is built only from `loadConfig` (to learn `memoryDir`), `memoryPaths`, `listDocuments`, and `readDocument`: all pure filesystem, no network, no index, no maintenance. `ReadDeps` structurally cannot reach a `ChatProvider`, an `EmbeddingProvider`, or a `MemoryEngine`, so this is enforced by the type signature, not just by discipline in the implementation.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/read.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReverieConfig } from '@openreverie/core'
import { ensureMemoryTree, memoryPaths, newId, writeDocumentAtomic } from '@openreverie/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ReadDeps, runRead } from './read.js'

function testConfig(memoryDir: string): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'fake-chat', reflection: 'fake-reflect', embeddings: 'fake-embed' },
    safety: { mode: 'companion', resources: [] },
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
  }
}

function fakeDeps(memoryDir: string, output: string[], colorEnabled = false): ReadDeps {
  return {
    loadConfig: async () => testConfig(memoryDir),
    write: (text: string) => output.push(text),
    colorEnabled,
  }
}

describe('runRead', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-read-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists the constitution, arcs, realms, and people with no arguments', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.arcsDir, 'marathon.md'),
      meta: { id: newId('doc'), name: 'Marathon training', status: 'active' },
      body: 'Training for the spring marathon.\n',
    })
    await writeDocumentAtomic({
      path: join(paths.realmsDir, 'health.md'),
      meta: { id: newId('doc'), name: 'Health' },
      body: 'A realm about health.\n',
    })
    await writeDocumentAtomic({
      path: join(paths.peopleDir, 'alex.md'),
      meta: { id: newId('doc'), name: 'Alex', node: 'person_1', opened: '2026-08-01T00:00:00.000Z' },
      body: 'This page is new. It grows as we talk.\n',
    })

    const output: string[] = []
    const exitCode = await runRead([], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('Constitution')
    expect(joined).toContain('Marathon training')
    expect(joined).toContain('Health')
    expect(joined).toContain('Alex')
  })

  it('prints the constitution header and full body', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const output: string[] = []
    const exitCode = await runRead(['constitution'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('Constitution')
    expect(joined).toContain('This constitution is empty. It grows as we talk.')
  })

  it('matches an arc by a case-insensitive substring of its name', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.arcsDir, 'marathon.md'),
      meta: { id: newId('doc'), name: 'Marathon training', status: 'active' },
      body: 'Training for the spring marathon.\n',
    })

    const output: string[] = []
    const exitCode = await runRead(['arc', 'MARATHON'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    const joined = output.join('')
    expect(joined).toContain('Marathon training')
    expect(joined).toContain('active')
    expect(joined).toContain('Training for the spring marathon.')
  })

  it('lists candidates and exits non-zero when a name is ambiguous', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.peopleDir, 'alex-smith.md'),
      meta: { id: newId('doc'), name: 'Alex Smith', node: 'person_1', opened: '2026-08-01T00:00:00.000Z' },
      body: 'This page is new. It grows as we talk.\n',
    })
    await writeDocumentAtomic({
      path: join(paths.peopleDir, 'alexis-park.md'),
      meta: { id: newId('doc'), name: 'Alexis Park', node: 'person_2', opened: '2026-08-01T00:00:00.000Z' },
      body: 'This page is new. It grows as we talk.\n',
    })

    const output: string[] = []
    const exitCode = await runRead(['person', 'alex'], fakeDeps(dir, output))

    expect(exitCode).not.toBe(0)
    const joined = output.join('')
    expect(joined).toContain('Alex Smith')
    expect(joined).toContain('Alexis Park')
  })

  it('reports plainly and exits non-zero when nothing matches', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const output: string[] = []
    const exitCode = await runRead(['arc', 'does not exist'], fakeDeps(dir, output))

    expect(exitCode).not.toBe(0)
    expect(output.join('').toLowerCase()).toContain('no arc')
  })

  it('searches all three kinds for a bare name and prints the one unambiguous match', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.realmsDir, 'health.md'),
      meta: { id: newId('doc'), name: 'Health' },
      body: 'A realm about health.\n',
    })

    const output: string[] = []
    const exitCode = await runRead(['health'], fakeDeps(dir, output))

    expect(exitCode).toBe(0)
    expect(output.join('')).toContain('A realm about health.')
  })

  it('completes with no provider and no API key present in the environment', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    await writeDocumentAtomic({
      path: join(paths.arcsDir, 'marathon.md'),
      meta: { id: newId('doc'), name: 'Marathon training', status: 'active' },
      body: 'Training for the spring marathon.\n',
    })

    const previousKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const output: string[] = []
      const exitCode = await runRead(['arc', 'marathon'], fakeDeps(dir, output))
      expect(exitCode).toBe(0)
      expect(output.join('')).toContain('Marathon training')
    } finally {
      if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey
    }
  })

  it('colors the header when colorEnabled is true and stays plain when false', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const colored: string[] = []
    await runRead(['constitution'], fakeDeps(dir, colored, true))
    expect(colored.join('')).toContain('\x1b[35m')

    const plain: string[] = []
    await runRead(['constitution'], fakeDeps(dir, plain, false))
    expect(plain.join('')).not.toContain('\x1b[')
  })

  it('prints the config error plainly and exits with code 1 when loadConfig throws', async () => {
    const output: string[] = []
    const deps: ReadDeps = {
      loadConfig: async () => {
        throw new Error('No config found. Run: reverie setup')
      },
      write: (text: string) => output.push(text),
      colorEnabled: false,
    }

    const exitCode = await runRead([], deps)

    expect(exitCode).toBe(1)
    expect(output.join('')).toContain('No config found. Run: reverie setup')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/cli/src/read.test.ts`
Expected: FAIL. `Cannot find module './read.js'` (or the equivalent TypeScript resolution error), since the file does not exist yet.

- [ ] **Step 3: Extract dim, cyan, and magenta into packages/cli/src/colors.ts**

`read.ts`'s only purpose is to be a lightweight filesystem read. Importing `magenta` from
`chat.ts` would transitively load the memory package and better-sqlite3 into a command whose
entire purpose is a plain filesystem read, so the color helpers move to their own module with no
other dependencies first.

Create `packages/cli/src/colors.ts`:

```ts
// Raw ANSI escapes, no dependency. Every helper here takes an explicit
// `enabled` flag rather than sniffing process.stdout.isTTY or NO_COLOR
// itself: that sniffing happens once, at the edge, in index.ts, and gets
// threaded down as a plain boolean. That keeps these functions (and the
// tests that exercise them) free of any dependency on real process state.
const ANSI_RESET = '\x1b[0m'
const ANSI_DIM = '\x1b[2m'
const ANSI_CYAN = '\x1b[36m'
const ANSI_MAGENTA = '\x1b[35m'

function colorize(code: string, text: string, enabled: boolean): string {
  return enabled ? `${code}${text}${ANSI_RESET}` : text
}

// Tool notices and warning notes: dim gray, easy to skim past.
export function dim(text: string, enabled = false): string {
  return colorize(ANSI_DIM, text, enabled)
}

// The user's own prompt.
export function cyan(text: string, enabled: boolean): string {
  return colorize(ANSI_CYAN, text, enabled)
}

// reverie's speaker tag. Soft magenta rather than a bright or bold color,
// so it reads clearly without fighting the terminal's own foreground on
// either a light or a dark background.
export function magenta(text: string, enabled: boolean): string {
  return colorize(ANSI_MAGENTA, text, enabled)
}
```

Remove the ANSI constants, `colorize`, `dim`, `cyan`, and `magenta` from `chat.ts` (currently lines
28-58), and replace them with an import from the new module:

```ts
import { cyan, dim, magenta } from './colors.js'
```

`toolNotice` and everything else in `chat.ts` stays exactly where it is.

Update `chat.test.ts`'s import so `cyan` and `magenta` come from `./colors.js` instead of
`./chat.js`:

```ts
import {
  type ChatIo,
  countMemoryDocuments,
  createStylePersister,
  openCliContext,
  printWarnings,
  runChat,
  toolNotice,
} from './chat.js'
import { cyan, magenta } from './colors.js'
```

The `describe('color helpers', ...)` tests in `chat.test.ts` are otherwise unchanged: only the
import path moves.

- [ ] **Step 4: Run the existing tests to verify the move is behavior preserving**

Run: `pnpm vitest run packages/cli/src/chat.test.ts -t "color helpers"`
Expected: PASS, unchanged behavior. Only the import path moved.

- [ ] **Step 5: Commit**

Commit message: `cli: extract dim, cyan, and magenta into their own module`

- [ ] **Step 6: Implement `packages/cli/src/read.ts`**

```ts
// Reads reverie's own record from the filesystem, with no engine, no
// provider, and no network call anywhere in this path. `MemoryEngine.open`
// runs runMaintenance (engine.ts), which can fire live reflection and
// embedding calls, and constructing a provider needs a resolvable API key.
// Reading your own record must work with the provider offline or
// unconfigured, so this module is built only from loadConfig (to learn the
// memory folder location), memoryPaths, listDocuments, and readDocument:
// pure filesystem, nothing else.
//
// Names come from document frontmatter, not the graph, which keeps this
// whole path free of the graph and the index.

import type { ReverieConfig } from '@openreverie/core'
import { type Document, listDocuments, memoryPaths, readDocument } from '@openreverie/memory'
import { magenta } from './colors.js'

export interface ReadDeps {
  loadConfig: () => Promise<ReverieConfig>
  write: (text: string) => void
  colorEnabled: boolean
}

type NamedKind = 'arc' | 'realm' | 'person'

interface Candidate {
  name: string
  path: string
}

export async function runRead(args: string[], deps: ReadDeps): Promise<number> {
  let config: ReverieConfig
  try {
    config = await deps.loadConfig()
  } catch (err) {
    deps.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  const paths = memoryPaths(config.memoryDir)

  if (args.length === 0) {
    return listOverview(paths, deps)
  }

  const [first, ...rest] = args
  if (first === 'constitution') {
    return printConstitution(paths, deps)
  }
  if (first === 'arc' || first === 'realm' || first === 'person') {
    const name = rest.join(' ').trim()
    if (name === '') {
      deps.write(`reverie read ${first} needs a name to look for.\n`)
      return 1
    }
    return printOneOfKind(paths, first, name, deps)
  }

  const name = args.join(' ').trim()
  return printSearchAllKinds(paths, name, deps)
}

async function loadCandidates(paths: ReturnType<typeof memoryPaths>, kind: NamedKind): Promise<Candidate[]> {
  const dir = kind === 'arc' ? paths.arcsDir : kind === 'realm' ? paths.realmsDir : paths.peopleDir
  const docs = await listDocuments(dir)
  return docs.map((doc) => ({
    name: typeof doc.meta.name === 'string' ? doc.meta.name : '(untitled)',
    path: doc.path,
  }))
}

function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase())
}

async function printOneOfKind(
  paths: ReturnType<typeof memoryPaths>,
  kind: NamedKind,
  name: string,
  deps: ReadDeps,
): Promise<number> {
  const candidates = await loadCandidates(paths, kind)
  const found = candidates.filter((c) => matches(c.name, name))

  if (found.length === 0) {
    deps.write(`No ${kind} found matching "${name}".\n`)
    return 1
  }
  if (found.length > 1) {
    deps.write(`More than one ${kind} matches "${name}":\n`)
    for (const candidate of found) deps.write(`  - ${candidate.name}\n`)
    return 1
  }

  const match = found[0]
  if (!match) return 1
  const doc = await readDocument(match.path)
  printDocument(deps, match.name, doc)
  return 0
}

async function printSearchAllKinds(
  paths: ReturnType<typeof memoryPaths>,
  name: string,
  deps: ReadDeps,
): Promise<number> {
  if (name === '') {
    deps.write('reverie read needs a name to look for.\n')
    return 1
  }

  const kinds: { kind: NamedKind; label: string }[] = [
    { kind: 'arc', label: 'arc' },
    { kind: 'realm', label: 'realm' },
    { kind: 'person', label: 'person' },
  ]
  const found: { name: string; path: string; label: string }[] = []
  for (const { kind, label } of kinds) {
    const candidates = await loadCandidates(paths, kind)
    for (const candidate of candidates) {
      if (matches(candidate.name, name)) found.push({ ...candidate, label })
    }
  }

  if (found.length === 0) {
    deps.write(`No arc, realm, or person found matching "${name}".\n`)
    return 1
  }
  if (found.length > 1) {
    deps.write(`More than one match for "${name}":\n`)
    for (const candidate of found) deps.write(`  - ${candidate.name} (${candidate.label})\n`)
    return 1
  }

  const match = found[0]
  if (!match) return 1
  const doc = await readDocument(match.path)
  printDocument(deps, match.name, doc)
  return 0
}

async function printConstitution(paths: ReturnType<typeof memoryPaths>, deps: ReadDeps): Promise<number> {
  const doc = await readDocument(paths.constitution)
  printDocument(deps, 'Constitution', doc)
  return 0
}

function printDocument(deps: ReadDeps, name: string, doc: Document): void {
  const details: string[] = []
  if (typeof doc.meta.status === 'string') details.push(doc.meta.status)
  if (typeof doc.meta.updated === 'string') details.push(`updated ${doc.meta.updated}`)
  const header = details.length > 0 ? `${name} (${details.join(', ')})` : name

  deps.write(`${magenta(header, deps.colorEnabled)}\n\n`)
  deps.write(`${doc.body}\n`)
}

async function listOverview(paths: ReturnType<typeof memoryPaths>, deps: ReadDeps): Promise<number> {
  deps.write(`${magenta('Constitution', deps.colorEnabled)}\n`)

  const arcs = await loadCandidates(paths, 'arc')
  deps.write(`\n${magenta('Arcs', deps.colorEnabled)}\n`)
  if (arcs.length === 0) deps.write('  (none yet)\n')
  for (const arc of arcs) deps.write(`  - ${arc.name}\n`)

  const realms = await loadCandidates(paths, 'realm')
  deps.write(`\n${magenta('Realms', deps.colorEnabled)}\n`)
  if (realms.length === 0) deps.write('  (none yet)\n')
  for (const realm of realms) deps.write(`  - ${realm.name}\n`)

  const people = await loadCandidates(paths, 'person')
  deps.write(`\n${magenta('People', deps.colorEnabled)}\n`)
  if (people.length === 0) deps.write('  (none yet)\n')
  for (const person of people) deps.write(`  - ${person.name}\n`)

  deps.write(
    '\nUse: reverie read constitution, reverie read arc <name>, reverie read realm <name>, ' +
      'or reverie read person <name>.\n',
  )
  return 0
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run packages/cli/src/read.test.ts`
Expected: PASS, all nine tests.

- [ ] **Step 8: Commit**

Commit message: `cli: add reverie read, a pure filesystem read of the memory record`

- [ ] **Step 9: Wire the subcommand into `packages/cli/src/index.ts`**

This is a plain edit, not a TDD cycle: `index.ts` is deliberately kept thin (per its own header comment), and none of the existing subcommand branches (`setup`, `reindex`, `reflect`) have a dedicated test either. `read.ts` already carries its own full test coverage from Step 1.

Update the header comment:

```ts
// Subcommands: `setup` runs the first-run wizard, `reindex` rebuilds the
// SQLite index from the memory folder, `reflect` runs maintenance
// (reflect stale sessions, build pending rollups) on demand, `read` prints
// part of the memory record without touching the network or the provider,
// and the default (no subcommand) starts the chat REPL.
```

Add the import and the dispatch branch, placed before `openCliContext` is ever called, so this path structurally cannot construct a provider or open the engine:

```ts
import type { ChatIo } from './chat.js'
import {
  countMemoryDocuments,
  createStylePersister,
  openCliContext,
  printWarnings,
  runChat,
} from './chat.js'
import { runRead } from './read.js'
import { runSetup } from './setup.js'
```

```ts
async function main(): Promise<void> {
  const subcommand = process.argv[2]

  if (subcommand === 'setup') {
    await runSetupCommand()
    return
  }

  if (subcommand === 'read') {
    const exitCode = await runRead(process.argv.slice(3), {
      loadConfig: () => loadConfig(defaultConfigPath()),
      write: (text: string) => process.stdout.write(text),
      colorEnabled: colorsEnabled(),
    })
    process.exitCode = exitCode
    return
  }

  const colorEnabled = colorsEnabled()
  const configPath = defaultConfigPath()
  // ...unchanged from here down
```

- [ ] **Step 10: Type-check**

Run: `pnpm build`
Expected: succeeds with no type errors across `cli`, `core`, and `memory`.

- [ ] **Step 11: Manual smoke check**

Run, in a scratch directory with no config file present and no provider API key set:

```
node packages/cli/dist/index.js read
node packages/cli/dist/index.js read constitution
```

Expected: the first prints "No config found. Run: reverie setup" (via `loadConfig`'s existing error) and exits with code 1, since `read` still needs a memory folder to point at; once a `config.toml` and memory folder exist (e.g. from a prior `reverie setup` run), both commands complete instantly with no network activity and no prompt for an API key.

- [ ] **Step 12: Commit**

Commit message: `cli: dispatch reverie read from the entry point`

---

### Task 9: recent session context widens beyond literally yesterday

**Files:**
- Modify: `packages/memory/src/engine.ts`:
  - `:70` (`SessionContext` field declaration)
  - `:294` (local accumulator)
  - `:303` (push site)
  - `:322` (returned object)
- Modify: `packages/core/src/context.ts:84-85` (`yesterdaySection` body)
- Test: `packages/memory/src/engine.test.ts` (new `describe('sessionContext recentSummaries', ...)` block)
- Test: `packages/core/src/context.test.ts`:
  - `:155`
  - `:173` (inside the section ordering list)
  - `:215` (asserts absence)
  - `:270` onward (the "includes the latest daily rollup and yesterday summaries when present" test, whose name also needs updating)

**Interfaces:**
- Consumes: `SessionStore.listSessions(paths): Promise<{ sessionId: string; date: string; reflected: boolean }[]>`, `addDaysUTC(date: Date, days: number): string`, `readDocument(path): Promise<Document>`
- Produces: `SessionContext['recentSummaries']: { sessionId: string; date: string; body: string }[]` (replaces `yesterdaySummaries`)

- [ ] **Step 1: Write the failing tests for the engine-level window, cap, order, and exclusion**

```ts
// packages/memory/src/engine.test.ts, inside describe('MemoryEngine', ...), after the
// existing 'sessionContext' describe block.

describe('sessionContext recentSummaries', () => {
  let dir: string
  let paths: MemoryPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-recent-'))
    paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function reflectedSessionOn(date: Date, body: string): Promise<void> {
    const store = await SessionStore.start(paths, date)
    await store.appendLine({ ts: date.toISOString(), role: 'user', content: body })
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: { id: newId('doc') },
      body: `${body}\n`,
    })
  }

  it('includes a session dated exactly seven days ago and excludes one dated eight days ago', async () => {
    const now = new Date()
    const sevenDaysAgo = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7),
    )
    const eightDaysAgo = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 8),
    )
    await reflectedSessionOn(sevenDaysAgo, 'Right at the edge of the window.')
    await reflectedSessionOn(eightDaysAgo, 'One day too old for the window.')

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const context = await engine.sessionContext(now)

    const bodies = context.recentSummaries.map((s) => s.body.trim())
    expect(bodies).toContain('Right at the edge of the window.')
    expect(bodies).not.toContain('One day too old for the window.')

    await engine.close()
  })

  it('caps recentSummaries at three, keeping the three most recent and dropping the oldest', async () => {
    const now = new Date()
    const daysAgo = (n: number) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n))

    await reflectedSessionOn(daysAgo(1), 'Most recent.')
    await reflectedSessionOn(daysAgo(2), 'Second most recent.')
    await reflectedSessionOn(daysAgo(3), 'Third most recent.')
    await reflectedSessionOn(daysAgo(4), 'Oldest, should be dropped.')

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const context = await engine.sessionContext(now)

    expect(context.recentSummaries).toHaveLength(3)
    expect(context.recentSummaries.map((s) => s.body.trim())).toEqual([
      'Most recent.',
      'Second most recent.',
      'Third most recent.',
    ])

    await engine.close()
  })

  it('orders recentSummaries most recent first', async () => {
    const now = new Date()
    const threeDaysAgo = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3),
    )
    const oneDayAgo = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
    )
    await reflectedSessionOn(threeDaysAgo, 'The older of the two.')
    await reflectedSessionOn(oneDayAgo, 'The more recent of the two.')

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const context = await engine.sessionContext(now)

    expect(context.recentSummaries.map((s) => s.body.trim())).toEqual([
      'The more recent of the two.',
      'The older of the two.',
    ])

    await engine.close()
  })

  it('excludes an unreflected session even when its date falls inside the window', async () => {
    const now = new Date()
    const twoDaysAgo = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2),
    )
    const store = await SessionStore.start(paths, twoDaysAgo)
    await store.appendLine({
      ts: twoDaysAgo.toISOString(),
      role: 'user',
      content: 'Never reflected.',
    })
    // No summary.md written: this session stays unreflected.

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const context = await engine.sessionContext(now)

    expect(context.recentSummaries).toHaveLength(0)

    await engine.close()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "recentSummaries"`
Expected: FAIL with `TypeError: context.recentSummaries is undefined` (the field is still called `yesterdaySummaries`).

- [ ] **Step 3: Rename and widen the field in engine.ts**

```ts
// packages/memory/src/engine.ts, SessionContext interface (was line 70):
  recentSummaries: { sessionId: string; date: string; body: string }[]
```

```ts
// packages/memory/src/engine.ts, near the other module constants (beside
// REALM_STARTER_BODY / ARC_STARTER_BODY):
const RECENT_SUMMARIES_WINDOW_DAYS = 7
const RECENT_SUMMARIES_CAP = 3
```

```ts
// packages/memory/src/engine.ts, sessionContext() method: replace the
// yesterday block (was lines 292-304) with:
    const sessions = await SessionStore.listSessions(this.paths)
    const recentCutoff = addDaysUTC(now, -RECENT_SUMMARIES_WINDOW_DAYS)
    const recentCandidates = sessions
      .filter((session) => session.reflected && session.date >= recentCutoff)
      .sort((a, b) => (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0))
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
```

(Ordering relies on session ids being ULIDs, which sort lexicographically by creation time; comparing them directly is simpler and more precise than comparing calendar dates alone, which cannot order two sessions from the same day.)

```ts
// packages/memory/src/engine.ts, the return statement's ...
    return {
      constitution: constitutionDoc.body,
      realms,
      arcs,
      ...(latestDailyRollup ? { latestDailyRollup } : {}),
      recentSummaries,
      pendingProposals: proposals,
      isFirstSession,
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "recentSummaries"`
Expected: PASS.

- [ ] **Step 5: Commit**

```
feat(memory): widen session context to the last seven days, capped at three

sessionContext gathered summaries from literally yesterday, so a greeting
after a gap of more than a day had nothing recent to open from. It now
gathers reflected sessions from the last seven UTC days, most recent
first, capped at three, and the field is renamed recentSummaries.
```

- [ ] **Step 6: Write the failing test for the renamed prompt section in core**

```ts
// packages/core/src/context.test.ts, replace every '## Yesterday' assertion
// (lines 155, 173, 215, 270 onward) with '## Recent sessions', and update the
// section-order test's headers array (line 173), and rename the test at line
// 270 (currently "includes the latest daily rollup and yesterday summaries
// when present"):
    const headers = [
      '## Constitution',
      '## Realms',
      '## Active arcs',
      '## Latest daily rollup',
      '## Recent sessions',
      '## Pending proposals',
    ]

// Also add a dedicated test in the same describe block confirming the
// date rides along with the body:
  it('shows the date of each recent session next to its summary', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const store = await SessionStore.start(paths, twoDaysAgo)
    await store.appendLine({
      ts: twoDaysAgo.toISOString(),
      role: 'user',
      content: 'A short, uneventful check-in.',
    })
    const dateString = twoDaysAgo.toISOString().slice(0, 10)
    await writeDocumentAtomic({
      path: join(store.dir, 'summary.md'),
      meta: { id: newId('doc') },
      body: 'Checked in briefly, nothing pressing.\n',
    })

    const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
    const prompt = await assembleSystemPrompt(engine, testConfig())

    expect(prompt).toContain('## Recent sessions')
    expect(prompt).toContain(dateString)
    expect(prompt).toContain('Checked in briefly, nothing pressing.')

    await engine.close()
  })
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/context.test.ts`
Expected: FAIL, `expect(prompt).toContain('## Recent sessions')` finding `'## Yesterday'` instead, plus a compile error once `yesterdaySummaries` no longer exists on `SessionContext`.

- [ ] **Step 8: Rename the section in context.ts**

```ts
// packages/core/src/context.ts, module doc comment (top of file): change
// "the latest daily rollup, yesterday's session summaries, and pending
// proposals" to "the latest daily rollup, session summaries from the last
// week, and pending proposals."

// assembleSystemPrompt's sections array:
  const sections = [
    persona,
    constitutionSection(context),
    realmsSection(context),
    arcsSection(context),
    latestDailyRollupSection(context),
    recentSummariesSection(context),
    pendingProposalsSection(context),
  ].filter((section): section is string => section !== undefined)

// Replace yesterdaySection with:
function recentSummariesSection(context: SessionContext): string | undefined {
  if (context.recentSummaries.length === 0) return undefined
  const parts = context.recentSummaries.map(
    (summary) => `${summary.date}: ${summary.body.trim()}`,
  )
  return `## Recent sessions\n\n${parts.join('\n\n')}`
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/context.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```
feat(core): rename the Yesterday prompt section to Recent sessions

Follows the memory package's widened window: the section now carries up
to three reflected sessions from the last seven days, each dated, instead
of only a session from literally yesterday.
```

---

### Task 10: AgentSession.greet

**Files:**
- Modify: `packages/core/src/agent.ts` (new `greet()` method after `send()`; new private `runGreeting()`; new module-level `withTimeout` helper, `GREETING_TIMEOUT_MS`, `GREETING_INSTRUCTION`)
- Test: `packages/core/src/agent.test.ts` (new tests, `vi` and `ChatProvider` added to imports)

**Interfaces:**
- Consumes: `ChatProvider.stream(req: ChatRequest): AsyncIterable<ChatEvent>`, `this.appendBoth`, `this.system`
- Produces: `greet(): AsyncIterable<AgentEvent>` (no user message, no tools, appends one assistant transcript line only)

- [ ] **Step 1: Verify the provider adapter's handling of an empty messages array and an empty tools array (read-only, not a test)**

Read `packages/providers/src/openai.ts`. `toOpenAiMessages` (line 69) only pushes the system message, then iterates `req.messages`; with `messages: []` it pushes nothing further, so the request body carries exactly one message (`role: 'system'`), which is a request shape the chat completions endpoint accepts. `toOpenAiTools` (line 95) returns `undefined` when `tools.length === 0`, and `buildRequestBody` (line 103) only sets `body.tools` when that function returns something truthy, so `tools: []` results in the `tools` key being omitted from the request entirely rather than sent as an empty array. Neither path throws or produces a malformed request.

Conclusion: the primary implementation (Step 3 below) calls `chat.stream({ model, system, messages: [], tools: [] })` directly. The fallback branch (documented at the end of Step 3) is not needed against this adapter, but is written out per the brief in case a future provider adapter rejects one of these shapes.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/core/src/agent.test.ts
// Add to the existing import line:
import { FakeChatProvider, FakeEmbeddingProvider, type ChatProvider } from '@openreverie/providers'
// Add vi to the vitest import:
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// New tests inside describe('AgentSession', ...):

  it('greet() streams the greeting and appends it as a single assistant line, with no user line', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you again. How has the week been?', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.greet())

    expect(events).toEqual([
      { type: 'text', text: 'Good to see you again. How has the week been?' },
      { type: 'done' },
    ])

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript.map((l) => l.role)).toEqual(['assistant'])
    expect(transcript[0]).toMatchObject({
      role: 'assistant',
      content: 'Good to see you again. How has the week been?',
    })

    expect(chat.requests[0]?.messages).toEqual([])
    expect(chat.requests[0]?.tools).toEqual([])

    await engine.close()
  })

  it('greet() writes a transcript line in the same shape as a normal assistant line', async () => {
    const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    await collect(session.greet())

    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript).toHaveLength(1)
    const [line] = transcript
    expect(line?.role).toBe('assistant')
    expect(line?.content).toBe('Hello again.')
    expect(typeof line?.ts).toBe('string')
    expect(line?.toolCalls).toBeUndefined()
    expect(line?.toolCallId).toBeUndefined()

    await engine.close()
  })

  it('greet() abandons silently, writing no transcript line, when the provider fails', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.greet())

    expect(events).toEqual([])
    const transcript = await engine.readTranscript(session.sessionId)
    expect(transcript).toEqual([])

    await engine.close()
  })

  it('greet() times out after 20 seconds without blocking, writing no transcript line', async () => {
    vi.useFakeTimers()
    try {
      const hangingChat: ChatProvider = {
        name: 'hanging',
        async complete() {
          throw new Error('not used in this test')
        },
        stream() {
          return (async function* () {
            await new Promise<never>(() => {
              // Never resolves: simulates a provider that stalls forever.
            })
          })()
        },
      }
      const engine = await MemoryEngine.open(dir, fakeDeps(hangingChat))
      const session = await AgentSession.start(engine, testConfig(), hangingChat)

      const resultPromise = collect(session.greet())
      await vi.advanceTimersByTimeAsync(20_001)
      const events = await resultPromise

      expect(events).toEqual([])
      const transcript = await engine.readTranscript(session.sessionId)
      expect(transcript).toEqual([])

      await engine.close()
    } finally {
      vi.useRealTimers()
    }
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/agent.test.ts -t "greet"`
Expected: FAIL with `TypeError: session.greet is not a function`.

- [ ] **Step 4: Implement greet() in agent.ts**

```ts
// packages/core/src/agent.ts, after MAX_TOOL_ROUNDS:
const GREETING_TIMEOUT_MS = 20_000

const GREETING_INSTRUCTION = `## Speak first

You are opening this session before the user has said anything. Say something now, unprompted.

If the guidance above is the first conversation guidance, follow it exactly: it already tells you how to open, so treat this as your instruction to do that now rather than wait to be spoken to.

Otherwise: always speak, even when nothing in particular needs raising. If nothing is pressing, one or two warm sentences with no agenda is enough.

If there is something worth opening with, choose exactly one, in this order, and lead with only that:
1. Something left unresolved from the most recent session.
2. Something notable in the recent record: a day that sounded hard, a milestone coming up.
3. Nothing. A short hello.

Never open with a list. Never summarize the record. Never give a status report. Say the one thing you picked the way you would say it out loud to someone you know, not the way you would write a briefing.

How hard you reach for a thread depends on your configured engagement: following stays light, leading is more willing to name one directly.`

// A single-use, per-call timeout wrapper around an async iterable: each
// call to the underlying iterator races against a fresh ms-long timer, so
// a provider that stalls between chunks (or never yields at all) throws
// instead of hanging forever. The timer is cleared after every step,
// whether it wins or loses the race.
async function* withTimeout<T>(iterable: AsyncIterable<T>, ms: number): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('AgentSession: greeting timed out')), ms)
    })
    try {
      const result = await Promise.race([iterator.next(), timedOut])
      if (result.done) return
      yield result.value
    } finally {
      clearTimeout(timer)
    }
  }
}
```

```ts
// packages/core/src/agent.ts, class AgentSession, after send():
  async *greet(): AsyncIterable<AgentEvent> {
    if (this.ended) {
      throw new Error('AgentSession: greet() called after end()')
    }
    const previous = this.sendChain
    let release: () => void = () => {}
    this.sendChain = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous
      yield* this.runGreeting()
    } finally {
      release()
    }
  }

  private async *runGreeting(): AsyncIterable<AgentEvent> {
    let text = ''
    try {
      const stream = this.chat.stream({
        model: this.model,
        system: `${this.system}\n\n${GREETING_INSTRUCTION}`,
        messages: [],
        tools: [],
      })
      for await (const event of withTimeout(stream, GREETING_TIMEOUT_MS)) {
        if (event.type === 'text' && event.text.length > 0) {
          text += event.text
          yield { type: 'text', text: event.text }
        }
      }
    } catch {
      // Any provider error, or the timeout above, abandons the greeting
      // silently. Unlike runTurn's error handling, nothing streamed so
      // far is appended to the transcript: the user never asked for this
      // message, so a half-written greeting has no source to point back
      // to. The user's first real message will surface a real provider
      // problem clearly.
      return
    }
    if (text.length > 0) {
      await this.appendBoth({ role: 'assistant', content: text })
    }
    yield { type: 'done' }
  }
```

Fallback branch, only if Step 1's verification against a given provider adapter shows an empty `messages` array or an empty `tools` array is rejected: replace the `stream` construction above with

```ts
      // A message the user never sent must never appear in the transcript,
      // so this line is passed to the provider directly and never touches
      // appendBoth or this.history.
      const SYNTHETIC_KICKOFF =
        'The user has not said anything yet. Speak first, following the instructions above.'
      const stream = this.chat.stream({
        model: this.model,
        system: `${this.system}\n\n${GREETING_INSTRUCTION}`,
        messages: [{ role: 'user', content: SYNTHETIC_KICKOFF }],
        tools: [],
      })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/agent.test.ts -t "greet"`
Expected: PASS.

- [ ] **Step 6: Commit**

```
feat(core): add AgentSession.greet for the proactive opening

Streams a model turn with the session's system prompt plus a greeting
instruction, no user message and no tools, and appends the result as a
single assistant transcript line. A provider error or a 20 second
timeout abandons the greeting silently, writing nothing to the
transcript.
```

---

### Task 11: the CLI opens the conversation, and empty sessions cost nothing

**Files:**
- Modify: `packages/memory/src/engine.ts` (top of `_doEndSession`, immediately after `const transcript = await SessionStore.readTranscript(...)`, currently around lines 185-196; new private `writeSkippedSummary`)
- Modify: `packages/cli/src/chat.ts` (new `runGreeting` function; `runChat` calls it before the loop that currently starts at line 144, right before the `io.question` call at line 147)
- Test: `packages/memory/src/engine.test.ts` (new `describe('empty session skip', ...)`)
- Test: `packages/cli/src/chat.test.ts` (new tests in `describe('runChat', ...)`)

**Interfaces:**
- Consumes: `AgentSession.greet(): AsyncIterable<AgentEvent>` (Task 10), `SessionStore.readTranscript`, `SessionStore.listSessions`
- Produces: no new public API; `_doEndSession` now writes a minimal `summary.md` (`skipped: true`, `reason: string`) instead of calling `reflectSession` for a transcript with no `user` line

- [ ] **Step 1: Write the failing tests for the empty-session skip (memory package)**

```ts
// packages/memory/src/engine.test.ts, inside describe('MemoryEngine', ...),
// after the 'runMaintenance' describe block. Reuses the existing
// emptyReflectionOutput helper already defined at the top of this file.

  describe('empty session skip', () => {
    let dir: string
    let paths: MemoryPaths

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-empty-'))
      paths = memoryPaths(dir)
      await ensureMemoryTree(paths)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('skips a session with only an assistant greeting, and never retries it across two runMaintenance calls', async () => {
      const chat = new FakeChatProvider([])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const now = new Date()
      const store = await SessionStore.start(paths, now)
      await store.appendLine({
        ts: now.toISOString(),
        role: 'assistant',
        content: 'Good to see you.',
      })

      await engine.runMaintenance(now)
      const sessionsAfterFirst = await SessionStore.listSessions(paths)
      expect(sessionsAfterFirst.find((s) => s.sessionId === store.sessionId)?.reflected).toBe(
        true,
      )
      expect(chat.requests).toHaveLength(0)

      await engine.runMaintenance(now)
      expect(chat.requests).toHaveLength(0)

      const summary = await readDocument(join(store.dir, 'summary.md'))
      expect(summary.meta.skipped).toBe(true)
      expect(typeof summary.meta.reason).toBe('string')

      await engine.close()
    })

    it('reflects normally through runMaintenance when the transcript has at least one user line', async () => {
      const chat = new FakeChatProvider([
        { text: JSON.stringify(emptyReflectionOutput('Said hello back.')), toolCalls: [] },
      ])
      const engine = await MemoryEngine.open(dir, fakeDeps(chat))

      const now = new Date()
      const store = await SessionStore.start(paths, now)
      await store.appendLine({
        ts: now.toISOString(),
        role: 'assistant',
        content: 'Good to see you.',
      })
      await store.appendLine({ ts: now.toISOString(), role: 'user', content: 'Hi.' })

      await engine.runMaintenance(now)

      expect(chat.requests).toHaveLength(1)
      const summary = await readDocument(join(store.dir, 'summary.md'))
      expect(summary.meta.skipped).toBeUndefined()
      expect(summary.body.trim()).toBe('Said hello back.')

      await engine.close()
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "empty session skip"`
Expected: FAIL, `chat.requests` has length 1 in the first test (reflection was attempted against an empty transcript), and `summary.meta.skipped` is `undefined`.

- [ ] **Step 3: Implement the skip in engine.ts**

```ts
// packages/memory/src/engine.ts, _doEndSession, right after reading the
// transcript, before buildReflectionContext:
  private async _doEndSession(sessionId: string): Promise<void> {
    const now = new Date()
    const transcript = await SessionStore.readTranscript(this.paths, sessionId)

    if (!transcript.some((line) => line.role === 'user')) {
      await this.writeSkippedSummary(sessionId, now)
      this.liveItems.delete(sessionId)
      return
    }

    const context = await this.buildReflectionContext()
    // ...unchanged from here down.
```

```ts
// packages/memory/src/engine.ts, new private method near the other
// private helpers (e.g. beside reindexOrWarn):

  // A session with no user line at all (an abandoned session that only
  // ever got as far as the proactive greeting) is not worth a reflection
  // call. It still needs a summary.md: that file's presence is what
  // SessionStore.listSessions() reads as "reflected", so without one this
  // session would be retried by every future runMaintenance() call
  // forever.
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

    const summaryDoc = await readDocument(summaryPath)
    await this.reindexOrWarn(
      summaryDoc,
      'summary',
      `session ${sessionId} summary (skipped, empty)`,
    )

    const commitResult = await commitMemory(
      this.paths.root,
      `reflect: session ${sessionId} skipped, no user messages`,
    )
    if (!commitResult.ok && commitResult.warning) {
      this.warnings.push(commitResult.warning)
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/memory/src/engine.test.ts -t "empty session skip"`
Expected: PASS.

- [ ] **Step 5: Commit**

```
fix(memory): skip reflection for a session with no user messages

A session that only ever got as far as an assistant greeting has nothing
to reflect on. It now gets a minimal summary.md carrying skipped: true
and a reason, instead of a reflection call, and instead of being retried
forever because the absence of summary.md is what marks a session
unreflected. Closes the "skip reflection for empty sessions" roadmap item,
which becomes mandatory once every abandoned session contains a greeting.
```

- [ ] **Step 6: Write the failing test for the CLI wiring**

```ts
// packages/cli/src/chat.test.ts, inside describe('runChat', ...). Reuses
// the existing scriptedIo, fakeDeps, and emptyReflectionJson helpers
// already defined at the top of this file.

  it('greets before the first prompt, streaming the greeting the same way it streams a reply', async () => {
    const chat = new FakeChatProvider([
      { text: 'Good to see you. How has the week been treating you?', toolCalls: [] },
      { text: 'Hi there.', toolCalls: [] },
      { text: emptyReflectionJson('Said hi.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await runChat({ engine, config, chat, io })

    const joined = output.join('')
    const greetingIndex = joined.indexOf('Good to see you. How has the week been treating you?')
    const promptIndex = joined.indexOf('you> ')
    expect(greetingIndex).toBeGreaterThanOrEqual(0)
    expect(greetingIndex).toBeLessThan(promptIndex)

    await engine.close()
  })

  it('prints nothing for the greeting when the provider fails, and still reaches the first prompt', async () => {
    const chat = new FakeChatProvider([])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['/bye'])

    await expect(runChat({ engine, config, chat, io })).resolves.toBeUndefined()

    const joined = output.join('')
    expect(joined).toContain('you> ')
    expect(joined).not.toContain('reverie> ')

    await engine.close()
  })
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/chat.test.ts -t "greets before the first prompt"`
Expected: FAIL, the greeting text never appears in `output` because `runChat` never calls `session.greet()`.

- [ ] **Step 8: Wire greet() into runChat**

```ts
// packages/cli/src/chat.ts, new function near runChat, above its
// definition:

// Streams AgentSession.greet() the same way the main loop streams a
// reply: the reverie> tag before the first chunk of text, plain writes
// after that. Error handling deliberately differs from a normal turn:
// any failure inside greet() (a provider error, or its own 20 second
// timeout) is swallowed here without a word, because the greeting was
// never asked for and a visible error about it would be confusing rather
// than honest. A real provider problem still surfaces normally on the
// user's first actual message.
async function runGreeting(session: AgentSession, io: ChatIo, colorEnabled: boolean): Promise<void> {
  let tagged = false
  try {
    for await (const event of session.greet()) {
      if (event.type === 'text') {
        if (!tagged) {
          io.write(magenta('reverie> ', colorEnabled))
          tagged = true
        }
        io.write(event.text)
      } else if (event.type === 'done' && tagged) {
        io.write('\n')
      }
    }
  } catch {
    // Silent abandon, per the greeting's own degradation rule.
  }
}
```

```ts
// packages/cli/src/chat.ts, inside runChat, right after the io.onInterrupt
// block and before the `for (;;) {` loop (previously line 144):

  await runGreeting(session, io, colorEnabled)

  for (;;) {
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/chat.test.ts`
Expected: PASS, including the full existing suite (no regressions).

- [ ] **Step 10: Commit**

```
feat(cli): speak first, before the user's first prompt

runChat now calls AgentSession.greet() and streams it exactly the way it
streams a reply, before the first you> prompt. A greeting failure prints
nothing and the prompt appears normally.
```

---

### Task 12: the thinking event

**Files:**
- Modify: `packages/core/src/agent.ts` (`AgentEvent` union; `runTurn`'s round loop, was lines 113-114; `runGreeting`, added in Task 10)
- Modify: `packages/core/src/agent.test.ts` (existing exact-array assertions at the tests named "runs a tool round then a final text round...", "serializes concurrent send() calls...", "rebuilds the system prompt when update_style succeeds...", "does not rebuild the system prompt when update_style fails...", plus the two Task 10 tests "greet() abandons silently, writing no transcript line, when the provider fails" and "greet() times out after 20 seconds without blocking, writing no transcript line", whose `expect(events).toEqual([])` assertions become `expect(events).toEqual([{ type: 'thinking' }])` now that `runGreeting` yields `thinking` before its try block)
- Test: `packages/core/src/agent.test.ts` (new tests for event ordering)

**Interfaces:**
- Consumes: nothing new
- Produces: `AgentEvent = { type: 'text'; text: string } | { type: 'tool'; name: string } | { type: 'thinking' } | { type: 'done' }`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/agent.test.ts, inside describe('AgentSession', ...):

  it('yields thinking at the start of every round, including after a tool call resumes the model', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'list_arcs', arguments: '{}' }],
      },
      { text: 'Here is what I found.', toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.send('What is going on?'))

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'tool', name: 'list_arcs' },
      { type: 'thinking' },
      { type: 'text', text: 'Here is what I found.' },
      { type: 'done' },
    ])

    await engine.close()
  })

  it('greet() also yields thinking before the greeting text', async () => {
    const chat = new FakeChatProvider([{ text: 'Hello again.', toolCalls: [] }])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const session = await AgentSession.start(engine, testConfig(), chat)

    const events = await collect(session.greet())

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'Hello again.' },
      { type: 'done' },
    ])

    await engine.close()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/agent.test.ts -t "yields thinking"`
Expected: FAIL, the first event received is `{ type: 'tool', ... }` or `{ type: 'text', ... }`, never `{ type: 'thinking' }`, because the type does not exist yet.

- [ ] **Step 3: Add the thinking event to the type and both event loops**

```ts
// packages/core/src/agent.ts
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'thinking' }
  | { type: 'done' }
```

```ts
// packages/core/src/agent.ts, runTurn, top of the round loop:
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      yield { type: 'thinking' }
      let text = ''
      const toolCalls: ToolCall[] = []
      // ...unchanged from here down.
```

```ts
// packages/core/src/agent.ts, runGreeting (added in Task 10), first line:
  private async *runGreeting(): AsyncIterable<AgentEvent> {
    yield { type: 'thinking' }
    let text = ''
    // ...unchanged from here down.
```

- [ ] **Step 4: Update the pre-existing exact-array assertions that this change ripples into**

```ts
// packages/core/src/agent.test.ts

// Test "runs a tool round then a final text round, forwarding events and
// the transcript in order":
    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'tool', name: 'search_memory' },
      { type: 'thinking' },
      { type: 'text', text: 'We went kayaking last spring, on the lake near your place.' },
      { type: 'done' },
    ])

// Test "serializes concurrent send() calls so their transcripts do not
// interleave":
    expect(eventsA).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'Reply A' },
      { type: 'done' },
    ])
    expect(eventsB).toEqual([
      { type: 'thinking' },
      { type: 'text', text: 'Reply B' },
      { type: 'done' },
    ])

// Test "rebuilds the system prompt when update_style succeeds...":
    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'tool', name: 'update_style' },
      { type: 'thinking' },
      { type: 'text', text: 'Now speaking playfully.' },
      { type: 'done' },
    ])

// Test "does not rebuild the system prompt when update_style fails":
    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'tool', name: 'update_style' },
      { type: 'thinking' },
      { type: 'text', text: 'Still warm.' },
      { type: 'done' },
    ])

// Test "greet() abandons silently, writing no transcript line, when the
// provider fails" (added in Task 10): the thinking event yields before the
// try block even runs, so it still happens ahead of the provider failure.
    expect(events).toEqual([{ type: 'thinking' }])

// Test "greet() times out after 20 seconds without blocking, writing no
// transcript line" (added in Task 10): same reasoning, the timeout fires
// inside the try block, after thinking has already been yielded.
    expect(events).toEqual([{ type: 'thinking' }])
```

(The "stops after 8 tool rounds" test uses `.filter()` and a last-element check, and the "keeps the transcript coherent when abandoning the iterator" test breaks on the first `tool` event; neither asserts a full array, so neither needs a change.)

- [ ] **Step 5: Run the full file to verify everything passes**

Run: `pnpm vitest run packages/core/src/agent.test.ts`
Expected: PASS, all tests including the four updated ones.

- [ ] **Step 6: Commit**

```
feat(core): emit a thinking event at the start of every model round

AgentEvent gains { type: 'thinking' }, yielded at the top of every round
in runTurn and in greet, so a consumer can tell the model has resumed
after a tool result instead of the terminal going silent with no signal.
```

---

### Task 13: the status line

**Files:**
- Create: `packages/cli/src/status.ts`
- Create: `packages/cli/src/status.test.ts`
- Modify: `packages/cli/src/chat.ts` (`runChat`'s deps and event loop, lines 103-209; `runGreeting`, added in Task 11)
- Test: `packages/cli/src/chat.test.ts` (new `describe('runChat status line', ...)`)

**Interfaces:**
- Consumes: `AgentEvent` (`thinking`, `tool`, `text`, `done`, from Task 12), `ChatIo.write`, `TOOL_NOTICES`
- Produces: `createStatusLine(deps: StatusLineDeps): StatusLine` exactly as the contract specifies

- [ ] **Step 1: Write the failing tests for the isolated status line module**

```ts
// packages/cli/src/status.test.ts
import { describe, expect, it } from 'vitest'
import { createStatusLine } from './status.js'

function fakeDeps(colorEnabled = true) {
  const output: string[] = []
  const intervals: Array<() => void> = []
  let clearedCount = 0
  let nowValue = 0
  return {
    output,
    intervals,
    setNow: (value: number) => {
      nowValue = value
    },
    tick: (index = 0) => {
      intervals[index]?.()
    },
    clearedCount: () => clearedCount,
    deps: {
      write: (text: string) => output.push(text),
      colorEnabled,
      setInterval: (fn: () => void, _ms: number) => {
        intervals.push(fn)
        return intervals.length
      },
      clearInterval: (_handle: unknown) => {
        clearedCount += 1
      },
      now: () => nowValue,
    },
  }
}

describe('createStatusLine', () => {
  it('advances frames on the injected interval, not a real timer', () => {
    const { deps, output, tick } = fakeDeps()
    const status = createStatusLine(deps)

    status.start('thinking')
    expect(output).toHaveLength(1)
    expect(output[0]).toContain('thinking')

    tick()
    tick()

    expect(output).toHaveLength(3)
    expect(output[0]).not.toBe(output[1])

    status.stop()
  })

  it('gains an elapsed seconds counter once three seconds have passed on the injected clock', () => {
    const { deps, output, tick, setNow } = fakeDeps()
    const status = createStatusLine(deps)

    status.start('thinking')
    setNow(3200)
    tick()

    expect(output[output.length - 1]).toContain('thinking (3s)')

    status.stop()
  })

  it('writes nothing at all and registers no interval when colorEnabled is false', () => {
    const { deps, output, intervals } = fakeDeps(false)
    const status = createStatusLine(deps)

    status.start('thinking')
    status.stop()

    expect(output).toHaveLength(0)
    expect(intervals).toHaveLength(0)
  })

  it('clears the line with a bare carriage return and erase before any real output follows', () => {
    const { deps, output } = fakeDeps()
    const status = createStatusLine(deps)

    status.start('thinking')
    status.stop()

    expect(output[output.length - 1]).toBe('\r\x1b[K')
  })

  it('clears the previous interval before registering a new one when start() is called twice without an intervening stop()', () => {
    const { deps, clearedCount } = fakeDeps()
    const status = createStatusLine(deps)

    status.start('thinking')
    status.start('searching memory')

    expect(clearedCount()).toBe(1)

    status.stop()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/status.test.ts`
Expected: FAIL, `Cannot find module './status.js'` (the file does not exist yet).

- [ ] **Step 3: Implement status.ts**

```ts
// packages/cli/src/status.ts
//
// A dim, animated status line shown between the end of the user's turn
// and the first real output: "thinking" while the model is working,
// or the honest tool label while a tool call is in flight. It writes
// through the same write funnel as everything else in the REPL, using
// \r and \x1b[K so each frame overwrites the last instead of scrolling
// the terminal. Frames advance on an injected setInterval and elapsed
// time is read from an injected clock, so tests never wait on a real
// timer.
//
// Gated entirely on colorEnabled: when the caller is not a color-capable
// TTY, start() and stop() do nothing at all, and no interval is ever
// registered. This preserves the existing invariant that no escape
// sequence reaches a non-TTY stream.

const ANSI_DIM = '\x1b[2m'
const ANSI_RESET = '\x1b[0m'
const FRAMES = ['|', '/', '-', '\\']
const FRAME_INTERVAL_MS = 120
const ELAPSED_THRESHOLD_MS = 3000

export interface StatusLineDeps {
  write: (text: string) => void
  colorEnabled: boolean
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  now: () => number
}

export interface StatusLine {
  start(label: string): void
  stop(): void
}

export function createStatusLine(deps: StatusLineDeps): StatusLine {
  if (!deps.colorEnabled) {
    return {
      start() {},
      stop() {},
    }
  }

  let handle: unknown
  let label = ''
  let startedAt = 0
  let frame = 0
  let active = false

  function render(): void {
    const elapsedMs = deps.now() - startedAt
    const text =
      elapsedMs >= ELAPSED_THRESHOLD_MS ? `${label} (${Math.floor(elapsedMs / 1000)}s)` : label
    const line = `${FRAMES[frame % FRAMES.length]} ${text}`
    deps.write(`\r${ANSI_DIM}${line}${ANSI_RESET}\x1b[K`)
  }

  return {
    start(nextLabel: string) {
      if (active) {
        deps.clearInterval(handle)
      }
      label = nextLabel
      startedAt = deps.now()
      frame = 0
      active = true
      render()
      handle = deps.setInterval(() => {
        frame += 1
        render()
      }, FRAME_INTERVAL_MS)
    },
    stop() {
      if (!active) return
      deps.clearInterval(handle)
      handle = undefined
      active = false
      deps.write('\r\x1b[K')
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
feat(cli): add the status line module

createStatusLine renders a dim, animated line through an injected write
funnel, gated entirely on colorEnabled: when that is false it writes
nothing and never registers a timer. Frame advance and elapsed time are
both injected, so tests never wait on a real clock.
```

- [ ] **Step 6: Write the failing tests for wiring it into runChat**

```ts
// packages/cli/src/chat.test.ts, new describe block after the existing
// 'runChat speaker rendering' describe. Reuses testConfig, fakeDeps,
// emptyReflectionJson, and scriptedIo already defined in this file.

describe('runChat status line', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'openreverie-chat-status-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('shows an animated thinking line that clears before the reply text, when colorEnabled is true', async () => {
    const chat = new FakeChatProvider([
      { text: 'Hi there.', toolCalls: [] },
      { text: emptyReflectionJson('Said hi.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await runChat({
      engine,
      config,
      chat,
      io,
      colorEnabled: true,
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => 0,
    })

    const joined = output.join('')
    const clearIndex = joined.indexOf('\r\x1b[K')
    const textIndex = joined.indexOf('Hi there.')
    expect(clearIndex).toBeGreaterThanOrEqual(0)
    expect(clearIndex).toBeLessThan(textIndex)
    expect(joined).toContain('thinking')

    await engine.close()
  })

  it('shows the honest tool label while a tool call runs, distinct from the permanent bracketed notice', async () => {
    const chat = new FakeChatProvider([
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'search_memory', arguments: JSON.stringify({ query: 'run' }) },
        ],
      },
      { text: 'Found something.', toolCalls: [] },
      { text: emptyReflectionJson('Looked something up.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['what did we talk about', '/bye'])

    await runChat({
      engine,
      config,
      chat,
      io,
      colorEnabled: true,
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => 0,
    })

    const joined = output.join('')
    expect(joined).toContain('searching memory')
    expect(joined).toContain('[searching memory]')

    await engine.close()
  })

  it('stays completely silent when colorEnabled is false, matching the existing no-escape guarantee', async () => {
    const chat = new FakeChatProvider([
      { text: 'Hi there.', toolCalls: [] },
      { text: emptyReflectionJson('Said hi.'), toolCalls: [] },
    ])
    const engine = await MemoryEngine.open(dir, fakeDeps(chat))
    const config = testConfig(dir)
    const { io, output } = scriptedIo(['hello', '/bye'])

    await runChat({ engine, config, chat, io })

    const joined = output.join('')
    expect(joined).not.toContain('\x1b[')

    await engine.close()
  })
})
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/chat.test.ts -t "status line"`
Expected: FAIL, `runChat` does not accept `setInterval`/`clearInterval`/`now`, and no `\r\x1b[K` or tool label ever appears in `output`.

- [ ] **Step 8: Wire createStatusLine into chat.ts**

```ts
// packages/cli/src/chat.ts, imports:
import { createStatusLine, type StatusLine } from './status.js'
```

```ts
// packages/cli/src/chat.ts, near toolNotice:
function toolStatusLabel(name: string): string {
  return TOOL_NOTICES[name] ?? `using: ${name}`
}
```

```ts
// packages/cli/src/chat.ts, runGreeting (added in Task 11) gains a
// statusLine parameter:
async function runGreeting(
  session: AgentSession,
  io: ChatIo,
  colorEnabled: boolean,
  statusLine: StatusLine,
): Promise<void> {
  let tagged = false
  try {
    for await (const event of session.greet()) {
      if (event.type === 'thinking') {
        statusLine.start('thinking')
      } else if (event.type === 'text') {
        statusLine.stop()
        if (!tagged) {
          io.write(magenta('reverie> ', colorEnabled))
          tagged = true
        }
        io.write(event.text)
      } else if (event.type === 'done' && tagged) {
        statusLine.stop()
        io.write('\n')
      }
    }
  } catch {
    // Silent abandon, per the greeting's own degradation rule.
  } finally {
    statusLine.stop()
  }
}
```

```ts
// packages/cli/src/chat.ts, runChat's signature and setup:
export async function runChat(deps: {
  engine: MemoryEngine
  config: ReverieConfig
  chat: ChatProvider
  io: ChatIo
  toolDeps?: ToolDeps
  colorEnabled?: boolean
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  now?: () => number
}): Promise<void> {
  const {
    engine,
    config,
    chat,
    io,
    toolDeps,
    colorEnabled = false,
    setInterval: setIntervalDep = (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: clearIntervalDep = (handle: unknown) =>
      clearInterval(handle as Parameters<typeof clearInterval>[0]),
    now = () => Date.now(),
  } = deps

  const statusLine = createStatusLine({
    write: io.write,
    colorEnabled,
    setInterval: setIntervalDep,
    clearInterval: clearIntervalDep,
    now,
  })

  io.write(`Memory folder: ${config.memoryDir}. Safety mode: ${config.safety.mode}.\n\n`)

  const session = await AgentSession.start(engine, config, chat, toolDeps)

  // ...interrupt handler setup unchanged...

  await runGreeting(session, io, colorEnabled, statusLine)

  for (;;) {
    // ...question() and /bye handling unchanged...

    let sawText = false
    let taggedThisTurn = false
    responding = true
    try {
      for await (const event of session.send(line)) {
        if (event.type === 'thinking') {
          statusLine.start('thinking')
        } else if (event.type === 'text') {
          statusLine.stop()
          sawText = true
          if (!taggedThisTurn) {
            io.write(magenta('reverie> ', colorEnabled))
            taggedThisTurn = true
          }
          io.write(event.text)
        } else if (event.type === 'tool') {
          statusLine.stop()
          io.write(`${dim(toolNotice(event.name), colorEnabled)}\n`)
          statusLine.start(toolStatusLabel(event.name))
        } else if (event.type === 'done') {
          statusLine.stop()
          io.write('\n')
          if (!sawText) {
            if (!taggedThisTurn) {
              io.write(magenta('reverie> ', colorEnabled))
              taggedThisTurn = true
            }
            io.write(LOST_IN_NOTES_MESSAGE)
          }
        }
        if (interruptLevel >= 2) {
          break
        }
      }
    } catch (err) {
      statusLine.stop()
      io.write(
        `\nI could not reach the model: ${errorMessage(err)}. Your message is saved; try again, or type /bye.\n`,
      )
    } finally {
      statusLine.stop()
      responding = false
    }

    if (interruptLevel >= 2) {
      return
    }
  }
}
```

(`index.ts` needs no change: omitting `setInterval`/`clearInterval`/`now` from its call to `runChat` picks up the real-timer defaults above.)

- [ ] **Step 9: Run the full suite to verify everything passes**

Run: `pnpm vitest run packages/cli/src/chat.test.ts`
Expected: PASS, including the pre-existing non-TTY escape-sequence test (previously at line 642) and every other existing `runChat` test.

- [ ] **Step 10: Commit**

```
feat(cli): show a status line while the model or a tool is working

Wires createStatusLine into runChat: an animated "thinking" line starts
on the thinking event, and the honest tool label while a tool call is in
flight, both cleared before any real text, tool notice, or done output
is written. Silent whenever colorEnabled is false.
```

---

### Task 14: README and ROADMAP honesty

AGENTS.md requires the README's Status section to reflect reality after any meaningful build
session, and calls overstating status a serious defect rather than a cosmetic one. The spec's
section 10 lists five deferred items that must reach ROADMAP.md rather than dying in the spec.
This task exists as its own task because it is the one most likely to be skipped, and skipping
it is the specific failure the project's own rules single out.

Run this task LAST, after every other task has landed, so it describes what actually exists.

**Files:**
- Modify: `README.md` (the Status section, lines 9 to 32)
- Modify: `ROADMAP.md` (the Done section, the smaller improvements list, lines 5 to 33)

**Interfaces:**
- Consumes: nothing in code. This task reads the finished branch and describes it.
- Produces: nothing in code.

- [ ] **Step 1: Verify what actually works before writing a word about it**

Do not write from the plan. Write from the code. Confirm each of these by reading the merged
code on this branch, and note anything that did not fully land:

```bash
git log --oneline main..HEAD
grep -n "peopleDir" packages/memory/src/paths.ts
grep -n "'person'" packages/memory/src/sqlite.ts
grep -n "resolveNarratives" packages/memory/src/reflection.ts
grep -n "async forget" packages/memory/src/engine.ts
grep -n "greet" packages/core/src/agent.ts
ls packages/cli/src/read.ts packages/cli/src/status.ts
pnpm test
```

If any of the above is missing, the README must not claim it. Report the gap rather than
writing around it.

- [ ] **Step 2: Update the README's "What works today" list**

Add, in the existing plain style, with no marketing tone and no em dashes:

- Reverie opens the conversation: a session starts with a short contextual hello, and when
  something is pressing it opens with that.
- Person pages: people who recur get a narrative document reflection maintains, alongside arcs.
- Memory saves by default, with a `forget` path: you are not asked for permission to remember,
  and you can ask reverie to forget something, which it removes from the record while saying
  plainly that the conversation transcript itself is never edited.
- `reverie read` prints your constitution, an arc, a realm, or a person page, with no network
  call and no API key needed.
- A status line while the model or a tool is working, so a slow call looks slow rather than
  looking stuck.

The existing bullet describing post-session reflection currently says it "produces
confidence-split proposals (high-confidence links are asserted automatically as unconfirmed;
everything else waits for you to accept or reject it)". That is no longer true. Rewrite it to
say that reflection files what mattered into memory directly, and that pending proposals from
before this release still resolve.

- [ ] **Step 3: Confirm the README's "What does not exist yet" list is still accurate**

Nothing is removed from it in this release. The web UI, providers other than OpenAI, deployment
targets beyond running it yourself, graph visualization, and monthly and yearly rollups are all
still absent. Verify each is genuinely still absent rather than assuming.

- [ ] **Step 4: Update ROADMAP.md**

- Mark the proactive session greeting item done, and the person pages item done. Both are in the
  "Smaller improvements, help welcome" list and must move out of it.
- Remove "Skip reflection for empty sessions" from that list. Task 11 closed it.
- Add a v0.3.0 paragraph to the Done section, in the same voice as the v0.2.0 paragraph, saying
  plainly what this release changed and why: the confirmation flow was removed because asking
  permission to remember does not fit a companion whose defining property is that it remembers.
- Add the five deferred items from the spec's section 10 to the smaller improvements list:
  retiring the proposal machinery once existing queues have drained; extending `forget` to
  session summaries and the items inside them; a deterministic significance threshold for person
  pages if letting reflection judge proves too loose; merging person aliases when one human ends
  up with more than one node; and purging forgotten content from the memory folder's git history.

- [ ] **Step 5: Check the prose against the project's style rules**

```bash
grep -n $'—' README.md ROADMAP.md
grep -niE "delve|seamless|robust|leverage|streamline|empower|unlock|supercharge" README.md ROADMAP.md
```

Both must return nothing. Read what you wrote once more and cut any sentence that sounds like
marketing rather than a plain statement of what is true.

- [ ] **Step 6: Commit**

```bash
git add README.md ROADMAP.md
git commit -m "Update the README and roadmap for what this branch actually changed"
```
