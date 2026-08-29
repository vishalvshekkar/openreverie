# Hosting openreverie's engine

This describes the seam a host uses to run this engine somewhere other than a person's own
machine: what a host must supply, what it can customize, and what fails loudly today versus what
does not yet. No specific host, commercial or otherwise, is described here. Nothing
product-specific belongs in this repository.

For the design reasoning behind any of this, see
[docs/superpowers/specs/2026-08-27-hostable-engine-design.md](superpowers/specs/2026-08-27-hostable-engine-design.md),
[docs/superpowers/specs/2026-08-27-hostable-engine-followup-design.md](superpowers/specs/2026-08-27-hostable-engine-followup-design.md),
and
[docs/superpowers/specs/2026-08-27-hostable-engine-canonical-origin-design.md](superpowers/specs/2026-08-27-hostable-engine-canonical-origin-design.md).
This page only points at what exists and where; it does not re-argue why.

## Storage

Every filesystem touch in `@openreverie/memory` goes through two injected interfaces in
`packages/memory/src/store.ts`: `FileStore` (whole-file reads and atomic writes) and
`AppendOnlyStore` (append-only logs, such as `graph.jsonl` and each session's transcript). A host
implements both over whatever storage it has.

`FileStore.readFile` carries a contract every implementation must satisfy: it must reject with an
error whose `.code` is `'ENOENT'` when the path does not exist, matching `node:fs/promises`'
`readFile`. `journal.ts` and `profile.ts` both depend on that exact code to tell "the file does not
exist yet" apart from any other read failure, and silently swallow anything that isn't `ENOENT`
into the wrong branch otherwise. This is documented directly on the interface in `store.ts`; read
it there for the full contract, including the ordering and locking guarantees the other methods
carry.

## Building an engine

`MemoryEngine.fromPaths(paths, index, deps, options)` in `packages/memory/src/engine.ts` builds an
engine from host-owned dependencies rather than a filesystem root path. A host constructs:

- `paths`: a `MemoryPaths`, built by `memoryPaths(root, stores)` in `packages/memory/src/paths.ts`
  over a `MemoryStores` (`{ files: FileStore, logs: AppendOnlyStore }`).
- `index`: a `MemoryIndex`, built by `MemoryIndex.fromDatabase(db)` in
  `packages/memory/src/sqlite.ts` over an injected `SqlDatabase` (the seam that lets a host with no
  `better-sqlite3` implement one over its own SQL engine).
- `deps`: an `EngineDeps` (`packages/memory/src/engine.ts`), carrying the chat and embedding
  providers, the model names, an explicit `timezone` (required, not defaulted to the ambient
  system zone, because a Durable Object's ambient zone is always UTC), an optional `now` clock, and
  the dream-related fields described below.

`MemoryEngine.open(root, deps, options)` is the self-hosted convenience path: it wires Node's own
filesystem stores and a real `better-sqlite3` database, then delegates to `fromPaths` itself.

## The Fetch HTTP entry point

`createFetchApp(deps)` in `packages/server/src/http-core.ts` is a Web-standard
`(Request) => Promise<Response>` entry point, an alternative to the `node:http` adapter. Its
`FetchAppDeps` requires `writeOriginPolicy` (`'required'` for browser-only clients, `'allow-missing'`
for authenticated native and command-line clients that never send `Origin`) and a canonical public
origin (`canonicalOrigin`, an origin-only `http:` or `https:` URL). The canonical origin must come
from host configuration, not from the address a developer happens to type into a browser: a Workers
development route can rewrite the incoming `Host` while leaving `Origin` unchanged.

## Customizing the prompt

`PersonaOptions` (`packages/core/src/personas.ts`) is the host-supplyable part of the system
prompt, today three optional fields:

- `deploymentContext`: replaces the deployment claim in the identity block. Second person.
- `firstConversationDeploymentClause`: replaces the deployment clause inside the first-conversation
  welcome sentence. Third person, clause length.
- `firstConversation`: replaces the whole welcome and onboarding script; when set, neither
  deployment field does any work.

Resolving the welcome's deployment clause fails closed when a host sets `deploymentContext` alone
without also setting the clause. See the doc comments on `PersonaOptions` and on
`resolveFirstConversationDeploymentClause` in `personas.ts` for the exact rule; it is not repeated
here.

`PersonaOptions` is threaded into every level a host might enter from: `buildPersona`,
`assembleSystemPrompt`, `AgentSessionOptions.persona`, `LiveSessionRegistryOptions.persona` (the
injection point a host that builds `LiveSessionRegistry` directly, without going through
`packages/server/src/launch.ts`, actually uses), and `ServerLaunchOptions.persona`.

`buildDreamPersona(mode, resources, options)`, also in `personas.ts`, exists because
`packages/memory` sits below `packages/core` and cannot import `buildPersona` itself. A host that
opens `MemoryEngine` directly, rather than through the CLI or server launcher, uses
`buildDreamPersona` to get its `PersonaOptions` into `EngineDeps.dreamPersona` in one line.

## What fails loudly today, and what does not yet

- Dreaming throws, and records the attempt as `'failed'`, when the rendered `dreamPersona` is empty
  or whitespace only, rather than running four model calls on an empty system prompt
  (`packages/memory/src/engine.ts`).
- A non-empty `dreamPersona` is not validated for content: a host can supply one that renders real
  prose with no crisis stance in it, and nothing today notices. Tracked in
  [BACKLOG.md](../BACKLOG.md) under "A host-supplied `dreamPersona` is not validated for content."
- Nothing enforces the length of a host-supplied `PersonaOptions` field. Tracked in
  [BACKLOG.md](../BACKLOG.md) under "A host-configurable prompt and tool-description surface."
- The rest of the composed system prompt, and the tool description text in `toolDefinitions()` and
  `DREAM_TOOLS`, are not yet host-configurable at all. Also tracked under "A host-configurable
  prompt and tool-description surface" in [BACKLOG.md](../BACKLOG.md).
