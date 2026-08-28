# Hostable engine: injecting the machine

Date: 2026-08-27. Status: released in v0.8.0.

## Why

Reverie Cloud runs this engine inside a Cloudflare Durable Object, one object per user. Its
change request lives at `../reverie-cloud/docs/specs/2026-08-27-openreverie-change-request.md`
and is the source for everything below. The engine's behavior does not change. Its assumptions
about the machine it runs on do.

Every item traces to a platform fact, not a preference: a Durable Object has no filesystem, no
native modules, no system timezone, a 2 MB cap on a single stored value, module-scope globals
shared between instances in one isolate, and floating promises cancelled when the request that
spawned them completes.

Two of these items we would want regardless of the hosted product, and they are the reason this
is worth doing rather than tolerating:

- Clock and timezone injection (P0-3). Our own `AGENTS.md` already requires injected clocks and
  pinned timezones in time-dependent tests, after three timezone-dependent failures in one day
  on 2026-08-25. The ambient reads are the remaining hole.
- An in-memory `FileStore` makes the suite hermetic and fast, with no temp directories.

Everything ships as a pure refactor of v0.7.3. No user-visible change to self-hosted openreverie.
Nothing here changes the memory folder format, the agent loop, the fourteen tools, the two safety
modes, crisis behavior, or the shape of the `/api/v1` contract.

## What we are building

### P0-1. Storage behind two injected interfaces

`packages/memory/src/store.ts` is a new leaf module importing nothing: `FileStore` (whole-file
reads and atomic writes, plus `mkdir`, `readdir`, `stat`, `exists`, `rm`, `rename`, and a
`capabilities` flag for versioning and locking) and `AppendOnlyStore` (`create`, `appendLines`,
`readAll`, `readRange`, and deliberately no write, rename, or rm).

Node implementations live in `packages/memory/src/nodeStore.ts` over today's `node:fs/promises`
code, including the existing temp-file-then-rename atomic write.

Two interfaces rather than one because documents are read and written whole while logs only grow.
Through a single byte-level interface, appending one transcript line means read-modify-write of
the whole file, which against the 2 MB cap forces chunked rows and rollover machinery. Giving
appends their own interface deletes that: one log line is one row.

Both stores hang off `MemoryPaths`, which is already threaded through 55 functions, so none of
those signatures change. The 58 direct `fs` call sites across 15 files become `paths.files.*` or
`paths.logs.*`.

One signature does change. `memoryPaths(root)` becomes `memoryPaths(root, stores)`, required,
since `store.ts` imports nothing and cannot construct a default. `nodeStore.ts` exports
`nodeStores()` for the callers in `cli`, `server`, and tests. There are 172 call sites and the
sweep is mechanical.

The interfaces stay async even though Durable Object SQLite is synchronous, because the Durable
Object implementations can return resolved promises while making them synchronous would touch
every call site and break the Node implementation.

Two things this deliberately is not. The cut is at path-and-line granularity, not semantic
(a `ProseStore` of documents, an `IndexStore` of engine operations); the semantic version is the
better long-term shape, is tracked in the cloud repo's backlog, and this cut is a strict subset
of it, so upgrading later is narrowing rather than rework. And `AppendOnlyStore` having no write
method does not make append-only compiler-enforced, since `files.writeFile(transcriptPath, ...)`
still type-checks.

What it does buy is narrower than the change request claimed, and the honest version is worth
stating. The request said all four log modules never receive a `FileStore` at all. Three of them
do not: `graph.ts`, `proposals.ts`, and `dreamLog.ts` touch `paths.logs` only, so for those the
append-only property is checkable at the imports of three files instead of by auditing every call
site. `transcripts.ts` is the exception and cannot be otherwise: alongside `transcript.jsonl` it
also writes `session.json` and creates the session directory, both of which are whole-file work.
It uses both stores, and says so in a comment at the top of the file.

Two call sites resist the pattern and are handled explicitly. `transcripts.ts` appends an empty
string to create the file, which is why `create(path)` exists as its own method. And `paths.ts`
appends to `.gitignore`, which is git plumbing rather than a log, so it uses `FileStore` and sits
behind `capabilities.versioning`.

### P0-2. `MemoryIndex` over an injected database

`MemoryIndex.db` is typed as a `SqlDatabase` interface rather than `Database.Database`, with a
`SqlStatement` interface alongside it. `static open(dbPath)` is unchanged for self-hosted;
`static fromDatabase(db)` is added for callers that already hold one.

`run` returns `{ changes, lastInsertRowid }` rather than void because the engine consumes it:
chunk indexing reads `lastInsertRowid` to link a new `chunks` row to its `chunks_fts` and
`embeddings` rows.

The interface names `getUserVersion` and `setUserVersion` rather than exposing `pragma()`, since
`user_version` is the only pragma the engine uses and re-exporting a better-sqlite3-ism would
make the Durable Object implementation invent one.

All five `.transaction()` call sites already take synchronous callbacks with no `await` inside,
which is what makes them expressible as `ctx.storage.transactionSync`.

### P0-3. Clock and timezone injection

`systemTimeZone()` stops being an implicit fallback. The engine callers pass a timezone:
`engine.ts` (which already prefers a stored profile timezone and only falls back), `paths.ts`,
`profile.ts`, `reflection.ts`, and `migrations/profileSeed.ts`.

`packages/cli/src/doctor.ts` keeps its call. A CLI genuinely runs on the person's machine, so
there the system timezone is the honest default rather than a lie; in a Worker it always resolves
to `UTC`, which is why the engine may not read it.

Wall-clock `Date.now()` reads become an injected clock in the same pass. Duration measurements
(the `model_call` timings in `dreaming.ts`) are not wall-clock and stay as they are.

### P0-4. Providers report token usage

`ChatResult` gains an optional `usage`, `ChatEvent` gains a `usage` variant, and
`EmbeddingProvider.embed` returns usage alongside vectors. `@openreverie/providers` is the single
choke point every model call passes through, and there is nowhere for a token count to come from
today.

Usage is optional on `ChatResult` so a provider that cannot report it is still valid. OpenAI's
streaming API returns usage only when `stream_options: { include_usage: true }` is set and
delivers it in a final chunk after the content, so the `usage` event is emitted near `done`
rather than with the text.

The new `ChatEvent` variant breaks exhaustive switches in existing consumers. Those call sites
handle it explicitly rather than through a default case, per the allow-list rule.

We are not building metering. Reverie Cloud wraps the provider in its own `ChatProvider` that
checks a usage ledger before delegating. The engine stays unaware, which is the point of the
choke point.

### P0-5. A background-work hook on `LiveSessionRegistry`

An optional injected `runBackground?: (work: Promise<unknown>) => void`, defaulting to today's
behavior, wrapping the `void this.runTurn(...)` that already detaches generation from the client
connection. In a Worker a floating promise is cancelled when the originating request completes,
so a person whose phone drops mid-response would lose the rest of the turn. Reverie Cloud passes
`ctx.waitUntil`.

### P0-6. Embedding rows record model and dimensions

The `embeddings` table gains `model` and `dims` columns, with a schema migration bumping
`INDEX_SCHEMA_VERSION`. A model change has to be detectable rather than silently producing a
corpus of mixed, incomparable vectors. The index is rebuildable, so this is cheap now and
expensive once a real corpus exists.

### P1-1. A transport-agnostic HTTP core

`createApp`'s handler becomes `(request: Request) => Promise<Response>` over Web-standard types,
with the existing `node:http` `RequestListener` kept as a thin adapter over it. Static asset
serving stays in the Node adapter, injected into the shared core as an optional hook, because it
needs `node:fs`.

The change request also put the bootstrap-token cookie flow in the Node adapter. As built it
stays in the shared core instead: it is one `set-cookie` header written through the same response
sink as everything else, and `deps.auth` was already pluggable, so there was nothing
Node-specific left in it to move. A host that authenticates its own way replaces `deps.auth` and
never reaches that route.

The Node coupling is concentrated in a handful of central helpers (`readJson`,
`readJsonOrEmpty`, `writeJson`, `writeNdjson`, `parseRequestUrl`, `requireHost`, and the header
reads) rather than spread through the route bodies, so most handler bodies survive.

The alternative is Reverie Cloud reimplementing the `/api/v1` contract, which means two
implementations of one contract drifting apart.

The requirement that must not be missed: `writeNdjson`'s replacement emits incrementally through
a `ReadableStream`. An implementation that accumulates events and returns a completed `Response`
passes a naive test and silently destroys token-by-token streaming, which is the product.

Rather than rewrite every route body from pushing at a `ServerResponse` to returning a `Response`,
the cut is a `ResponseSink` interface named after the seven members the route bodies actually use
(`setHeader`, `writeHead`, `write`, `end`, `once`, `off`, `headersSent`). `ServerResponse` already
satisfies it, so the Node adapter passes one straight through and the route bodies do not change
at all. The Web adapter supplies a sink that resolves its `Response` at `writeHead` time with the
`ReadableStream` still open, so each later `write` enqueues to a consumer already reading. That is
what makes the streaming incremental by construction rather than by care.

`write` and `end` take `string | Uint8Array`, not just `string`. Static assets include images and
fonts, and a string round trip corrupts every byte at or above 0x80.

### P1-2. Web app auth pluggability

`packages/web` gets a configurable API base URL and a way to be told it is already authenticated,
so the bootstrap-token screen is skipped. Self-hosted still shows and uses that screen exactly as
it does now. Everything else in the client is unchanged because the API contract is unchanged.

## What we checked and are deliberately not doing

Each of these looked like it needed work and does not.

- `ReverieConfig` is already constructable directly. `loadConfig` / `saveConfig` /
  `defaultConfigPath` are separate functions from the interface.
- Detached generation already exists. The registry already runs the turn independently of the
  returned iterator, records into a replay buffer, and lets a client catch up from a sequence
  number. Only the lifetime hook (P0-5) was missing.
- Scheduling is already injectable through `RegistryScheduler` and the `now` option.
- Auth is already injectable through `deps.auth.authenticate`.
- The dream file lock does not need removing, only disabling, since a Durable Object is
  single-threaded. `capabilities.locking` covers it, and `capabilities.versioning` covers git
  auto-commit the same way.

## How we will know it worked

- The existing suite passes unchanged, after `pnpm build`, with `pnpm exec tsc --noEmit` clean.
- Local on-disk output is byte-for-byte identical to v0.7.3, including temp-file naming and the
  trailing-newline normalization in `writeDocumentAtomic`.
- Every new guarantee has a test shown to fail when the specific behavior it names is mutated,
  not when the feature is deleted wholesale. Named cases: adding a rewrite path to a log makes
  the append-only test fail; a deliberately slow event generator proves bytes reach the consumer
  before the generator finishes; token counts survive both `complete()` and `stream()`; a
  mismatched-dimension vector is rejected rather than compared.
- Time-dependent tests pin the timezone explicitly or assert something true in every timezone.
