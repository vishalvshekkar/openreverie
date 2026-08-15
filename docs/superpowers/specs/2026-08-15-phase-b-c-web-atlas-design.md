# Phase B and C design: local web interface and atlas

Date: 2026-08-15
Status: approved by Vishal, including the six-package amendment
Targets: v0.4.0 (Phase B) and v0.5.0 (Phase C)

This specification extends the original design and the Phase A companion quality design. It adds
a local web interface without changing the memory folder as the source of truth. This document is
the source of truth for the web work. The owner approved the six-package amendment. `AGENTS.md`
must be updated in the same documentation commit as this specification, before any implementation
plan or code is made for this work.

## 1. Scope and release shape

Phase B adds a local server, a React web client, launch-scoped local authentication, chat and
session browsing, document browsing, a graph API, and the first usable atlas view. The CLI remains
supported as a sibling interface.

Phase C makes the atlas a full-screen reading and navigation surface. It adds stable local
positions, realm influence, search, navigation, filtering, progressive labels, and a history time
lens. Constellation layout is deferred.

The web client remains useful when no provider is configured or reachable. It can list and read
documents, inspect sessions, and browse the graph. Sending a message reports chat unavailable and
does not fabricate a response.

## 2. Architecture amendment

The original four-package architecture is amended to six packages:

```
cli       terminal interface and setup commands
server    native Node HTTP interface and live process orchestration
core      conversation loop, context assembly, tools, and safety modes
memory    files, graph log, reflection, rollups, retrieval, and derived index
providers chat and embedding provider interfaces and adapters
web       React browser client, HTTP API client, and presentation
```

The dependency graph is:

```
cli -> core -> memory -> providers
server -> core -> memory -> providers
web -> HTTP API only
```

`server` is the outer composition root. Where feasible it obtains providers through core/provider
factories. It may also construct configured providers through the public interfaces in
`@openreverie/providers`. It never calls a vendor SDK directly. `web` imports no runtime workspace
engine, provider, Node, or memory implementation. The browser learns about records only through the
versioned HTTP API.

The server uses Node 22 `node:http`, with Zod validation at request, provider-result, and public
response boundaries. It owns one `MemoryEngine` and one live-session registry. It does not duplicate
memory logic. The web package uses React 19, Vite, and plain CSS. Phase C rendering dependencies,
if added, stay inside `web`.

## 3. Local bootstrap and origin contract

The foreground server binds to `127.0.0.1` only. At startup it chooses a port and prints the
canonical origin `http://127.0.0.1:<port>` and a full bootstrap URL. It may optionally open that
same full URL in the default browser. The URL contains a launch token, and the exact URL printed,
opened, and used by the browser has the same canonical origin.

`POST /api/v1/auth/bootstrap` accepts JSON `{ "token": string }`. The token is generated from 32
cryptographically random bytes, is single-use, and expires five minutes after process startup.
Successful exchange sets an `HttpOnly; SameSite=Strict; Path=/` cookie. Its lifetime is tied to the
server process, so it is invalid after restart. The UI then redirects to the clean canonical origin
and removes the token from the address bar using redirect/history. Tokens never appear in logs,
referrers, error text, or analytics, and no analytics are collected. Replay or expiry returns a
generic `401` JSON response with no indication of which condition occurred.

Every `/api/v1` endpoint except `POST /api/v1/auth/bootstrap` requires the valid process-bound
`HttpOnly` cookie. Bootstrap authenticates with its one-time launch token. Origin and `Host`
validation are additional CSRF and request-routing protections, and never substitute for
authentication. State-changing requests require the exact canonical `Origin`; `GET` and `HEAD`
requests may omit `Origin`, but still require the authenticated cookie and exact canonical `Host`.

The canonical `Host` header must be exactly `127.0.0.1:<port>`. `localhost` and IPv6 are not aliases
in v0.4. State-changing browser requests must carry the exact `Origin` matching the canonical
origin. There is no CORS support.

## 4. API conventions and bounds

The API is rooted at `/api/v1`. Ordinary responses use `application/json`; message streams use
`application/x-ndjson; charset=utf-8`. Every successful ordinary response uses the envelope
`{ "data": ..., "meta": { "nextCursor": string | null } }`. `nextCursor` is null at the end of
the collection. Error responses retain `schemaVersion: "1"`, `code`, and a user-safe `message`.
Unknown routes, sessions, documents, or IDs return `404` JSON. Request JSON is limited to 256 KiB,
chat message text to 64 KiB UTF-8, query strings to 8 KiB, and path IDs to 256 characters after
validation. Oversized bodies or messages return `413`; an oversized query string returns `414`.
There are at most eight live sessions and one active stream per session. Capacity exhaustion returns
`429`. Messages are serialized per session, so no arbitrary per-session event-rate limit is needed.

Lists use opaque, versioned base64url cursors. A cursor encodes its resource kind and the complete
last sort tuple, and may include a server-process snapshot revision. A cursor is invalid or stale
when it cannot be decoded, has the wrong resource kind, or cannot be applied to the current source
state, returning `400` with `code: "cursor_invalid"`. Each page contains only records strictly after
the cursor tuple. Concurrent inserts before a cursor may be absent until a fresh listing, but never
appear twice. Mutable document metadata may invalidate a cursor and require a fresh listing.
Sessions sort by (`startedAt` DESC, `id` DESC), documents by (`kind` ASC, `title` ASC, `id` ASC),
proposals by (`createdAt` ASC, `id` ASC), transcripts by line sequence ASC, and graph events by
append sequence ASC. Sessions and documents default to 50 and accept at most 200. Transcript pages
default to 200 lines and accept at most 1000. A page may contain fewer records than requested because
of its byte limit. No response contains partial JSON or a partial record.

## 5. Sessions and message streams

Endpoints:

```
POST /api/v1/sessions
GET  /api/v1/sessions?cursor=<opaque>&limit=<1..200>
GET  /api/v1/sessions/:sessionId
POST /api/v1/sessions/:sessionId/message
GET  /api/v1/sessions/:sessionId/transcript?cursor=<opaque>&limit=<1..1000>
GET  /api/v1/sessions/:sessionId/events
POST /api/v1/sessions/:sessionId/end
```

`POST /sessions` returns JSON session metadata and, when an opening greeting is produced, its
initial greeting stream URL. Session list and detail objects contain `sessionId`, `createdAt`,
`updatedAt`, `status` (`live`, `ended`, or `expired`), `readOnly`, and transcript summary
counts. `GET /transcript` is a provider-free, read-only paginated projection of the append-only
`transcript.jsonl`. Each record contains its 1-based `lineSequence`, `role`, `content`, `ts`, and
any existing public message metadata. Transcript records are returned in append order. This is
distinct from `/events`: transcript records are durable conversation lines, while `/events` is the
live NDJSON replay buffer of ephemeral stream events and is not a transcript representation.
Individual document content is limited to 4 MiB UTF-8; exceeding it returns `413` with
`code: "resource_too_large"`. A transcript page is limited to 4 MiB and ends at the last complete
line under that limit, with a cursor for that line. If one transcript line alone exceeds 4 MiB,
the server returns `413` with `code: "record_too_large"`.

`POST /sessions/:id/message` requires `X-Reverie-Turn-Id`. The value is a UUID or another opaque
identifier matching the server's bounded identifier grammar and no longer than 128 characters.
It accepts `{ "message": string }` and returns NDJSON. Each line has
`schemaVersion`, a monotonically increasing numeric `seq`, and exactly one variant: `thinking`,
`text`, `tool`, `done`, or `error`. `done` or `error` is exactly one terminal event per turn.
Errors contain only `code`, `retryable`, and a user-safe `message`, never sensitive internals.
Initial messages omit the resync header. A reconnect sends `X-Reverie-Last-Sequence`; the server
replays events after that sequence. If the replay buffer no longer contains the requested sequence,
the server returns `409` JSON `{ "schemaVersion":"1", "code":"resync_required" }`. The same
header mechanism is used by POST fetch, so no separate transport is required.

For every accepted turn, the live-session process registry retains a compact idempotency record for
the live session lifetime: turn ID, canonical request-body SHA-256 hash, terminal status, and event
sequence range. The canonical request is UTF-8 JSON containing only the `message` property,
preserving the exact message text. These records are independent of replay event bytes, so they
remain after replay events are evicted. A retry with the same session and turn ID and the same body
reconnects to or replays the existing stream, without duplicating transcript writes or model work.
If that turn's event bytes have been evicted, the known same-body retry returns `409` with
`code: "resync_required"` and directs the client to fetch the saved transcript; it never reruns
model work. The same turn ID with a different body returns `409` with
`code: "idempotency_conflict"`. A different turn ID while one turn is active returns `409`.
The live session accepts at most 4096 turns. After that limit, new turns return `409` with
`code: "session_turn_limit"`, and the user must start a new session. Turn records disappear only
when the live session or process ends, at which point the session is read-only. After restart,
existing sessions are read-only.

The replay window defaults to 256 complete events per session and the live stream has a 1 MiB cap.
When either bound is reached, the server evicts the oldest complete events. An NDJSON event line is
limited to 256 KiB. A disconnected session expires after 30 minutes of inactivity. `end` is
idempotent. Posting to an ended or expired session returns `409`. A process restart leaves existing
transcripts browsable but makes sessions read-only; it does not restore live sessions.

All chat goes through the existing core `AgentSession` safety and persona paths. HTTP handlers do
not bypass them or alter crisis logic. Provider outage preserves record browsing and returns chat
unavailable with the transcript intact.

## 6. Documents and proposals

```
GET /api/v1/documents?cursor=<opaque>&limit=<1..200>
GET /api/v1/documents/:docId
GET /api/v1/proposals?cursor=<opaque>&limit=<1..200>
POST /api/v1/proposals/:proposalId/resolve
```

Document list rows contain `docId`, `kind`, `title`, `updatedAt`, and `readOnly`. Reads return the
same public metadata plus the markdown body. Paths are never exposed. Document pagination follows
the opaque cursor rules and defaults to 50, maximum 200. Proposal pages use the same envelope,
sort by (`createdAt` ASC, `id` ASC), default to 50, and accept at most 200. A proposal page is
limited to 2 MiB. Proposal endpoints are legacy, non-conversational arbitration compatibility
only, for older memory folders. They are never a permission-to-remember flow, and they are not
part of `SessionContext` or the model tool surface. The web UI must not present a proposal as a
request for permission to retain a person, entity, or relationship.

## 7. Graph API and faithful history

```
GET /api/v1/graph/snapshot
GET /api/v1/graph/events?after=<opaque-cursor>&limit=<1..2000>
```

The snapshot `data` object has `revision`, `nodes`, and `edges`. Nodes have exactly `id`, `type`,
`label`, optional `docId`, and `assertedAt` (an exact timestamp string). `docId` is optional for
every node type. Person and entity nodes are first-class graph records whether or not they have a
page, and the atlas and its semantic node list must keep every such node selectable without a
page. A person page may be promoted later: that promotion preserves the existing node `id` and
starts emitting `docId`; it must not change layout identity or link identity. Edges have exactly `key`,
`type`, `from`, `to`, `confidence`, `confirmed`, optional `sourceSessionId`, and `assertedAt`.
Event `data` records have exactly `sequence` (the 1-based append line position), `op`, and
`assertedAt`, plus exactly one of these operation fields: `node` for `op: "assert", kind: "node"`
(a node shape), `edge` for `op: "assert", kind: "edge"` (an edge shape), `nodeId` for
`op: "retract", kind: "node"`, or `edgeKey` for `op: "retract", kind: "edge"`. These four
`(op, kind)` combinations are the complete event contract. Events are a normalized, faithful
projection of raw `graph.jsonl` in append order. Normalization may rename fields such as source
`ts` to `assertedAt` and shape payloads, while preserving graph operation semantics. Assert and
retract events are never omitted, including dangling events. The cursor encodes the last source
sequence, and pagination sorts by sequence ASC. The default graph-event limit is 500 and the hard
maximum is 2000. Dangling events may be omitted only from the current folded snapshot.

The snapshot is the complete folded active graph, with a fixed v0.4 hard limit of 8 MiB for the
uncompressed JSON response. Exceeding it returns `413` with structured
`{ "schemaVersion":"1", "code":"graph_snapshot_too_large", "message": string }`; the server never
paginates or silently omits nodes. Compression does not change this guard.

Snapshot nodes are sorted exactly by (`assertedAt` ASC, `id` ASC), and edges exactly by
(`assertedAt` ASC, `key` ASC). `assertedAt` is the exact projection and rename of the source log
`ts`. Canonical JSON is UTF-8 with object keys sorted lexically and recursively, arrays sorted in
the required order above, and no insignificant whitespace. Canonical uncompressed snapshot bytes
are the canonical JSON bytes of `{ "nodes": [...], "edges": [...] }`, before adding `revision` to
the response data. The revision is lowercase hexadecimal SHA-256 of those bytes. The ETag is the
quoted revision. The same folded source state therefore produces the same bytes, revision, and
ETag. `If-None-Match` may return `304`. The uncompressed snapshot response is limited to 8 MiB.

Graph event pages are limited to 8 MiB total and 256 KiB per event. The server stops at the last
complete event and returns its next cursor. If one event alone exceeds 256 KiB, it returns `413`
with `code: "record_too_large"`.

## 8. Phase B and C feature matrix

| Capability | Phase B, v0.4 | Phase C, v0.5 |
| --- | --- | --- |
| Graph data | Load complete snapshot | Same snapshot contract |
| Layout | Deterministic seed layout only | Stable local positions |
| Navigation | Select node, accessible node list, open document by `docId` | Search and filter navigation |
| Presentation | Basic pan and zoom, type legend and filter | Polished full-screen atlas and progressive labels |
| Realms | Render nodes as ordinary graph data | Realm anchors and temporary influence visualization |
| History | No history or time lens | History time lens |
| Deferred | No saved-position refinement, realm influence, progressive labels, graph search, or history lens | Constellation remains deferred |

Neither phase writes graph relationships or layout coordinates to the memory folder. Influence is
temporary visual state, not a graph assertion.

## 9. Web experience and safety

Phase B provides session and transcript browsing, document browsing, proposal inspection, and the
basic atlas. It supports explicit end and new-chat actions and reconnects with its last sequence.
The atlas has a semantic parallel list for keyboard and screen-reader users, and tolerates empty
graphs and unavailable providers. The visual system is monochrome, readable, keyboard-operable,
focus-visible, reduced-motion aware, and supports light and dark themes.

The browser never infers relationship truth from prose. It displays graph provenance, confidence,
confirmation state, and assertion history. It resolves node documents by `docId` when one exists,
and keeps unpaged person and entity nodes usable when it does not. No safety mode or crisis behavior
changes in either phase.

If a future API exposes conversation context, its people and entity fields must match the current
`SessionContext` contract: `people: { id, name, hasPage }[]`, `peopleTruncated`,
`entities: { id, name }[]`, `entitiesTruncated`, and `recentIntentions`. It must not expose the
retired `pendingProposals` field or imply that creation-order caps represent recently discussed
people or entities. The current caps are bounded selection limits, with truncation disclosed.

## 10. Review, diagnostics, and landing obligations

Deterministic tests cover request limits and Zod boundaries, session serialization, replay and
resync, expiry, bootstrap and origin checks, transcript projection, graph folding, faithful event
cursoring, canonical ordering, ETag and size guards, pagination, and provider-free reads. Browser
tests cover reconnect, document opening, atlas selection, semantic list parity, themes, keyboard
accessibility, and Phase B/C feature boundaries. No personal data enters fixtures.

This project has no telemetry or analytics. Do not invent telemetry metrics. Revisit bounds using
local tests and manual diagnostics only, without logging memory contents, message bodies, or provider
payloads.

At the actual Phase B landing, update `README.md` Status and the relevant `ROADMAP.md` entry to
describe what shipped and what remains. Repeat those updates at the actual Phase C landing. They are
not part of this design-only change and must not claim capabilities before they exist.

Until the server and web packages land, `README.md` must truthfully describe the four implemented
packages. When those packages land, update the README architecture and Status sections atomically
with the implementation. This design-only commit does not make that update.
