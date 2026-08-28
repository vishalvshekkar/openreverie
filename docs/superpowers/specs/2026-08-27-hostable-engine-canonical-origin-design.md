# Hostable engine: the canonical origin is public, not local

Date: 2026-08-27. Status: released in v0.8.0.

## What real clients found

The shared HTTP app validates its canonical origin when the app is constructed. That validation
currently accepts only an explicit-port origin on `127.0.0.1`. This confuses the address the Node
server binds to with the public origin clients use. A hosted deployment, a self-hosted reverse
proxy, and local development through `localhost` all have legitimate public origins that do not
match that shape.

Authenticated writes have a separate compatibility problem. They currently require an `Origin`
header even though native and command-line HTTP clients do not normally send one. Those clients
pass authentication and then receive an origin error that they cannot resolve.

Both problems are in the shared HTTP core. The accepted B1, F2, F3, and F4 changes remain
unchanged.

## B2a: accept public HTTP origins

The canonical-origin parser accepts an absolute `http:` or `https:` URL for any hostname. The URL
must describe an origin only: no credentials, query, fragment, or path other than `/`. Ports are
optional because both schemes have standard default ports.

The parser continues to return the normalized `URL.origin` and `URL.host`. `requireHost` keeps its
exact host comparison, and the write guard keeps its exact origin comparison. The change is only
which valid public origins may reach those checks.

`launch.ts` continues to construct `http://127.0.0.1:${port}`. That remains valid and preserves the
self-hosted process's current behavior.

## B2b: distinguish a missing origin from a foreign origin

The shared Fetch app requires the host to choose a write-origin policy. `required` rejects a
missing header and preserves the self-hosted Node adapter's existing browser-only behavior.
`allow-missing` accepts a missing header after the existing host and authentication checks pass.
Both policies reject an `Origin` value that differs from the canonical origin.

Making the choice required avoids a silently permissive default and avoids a silently broken
native client when a host forgets to configure the boundary. Reverie Cloud can choose
`allow-missing`; the Node adapter chooses `required`, so this remains a behavior-neutral refactor
for the released self-hosted product.

Both choices keep the browser boundary intact. A browser cross-site write supplies a foreign
origin and is rejected. The session cookie is also `SameSite=Strict`, so a cross-site request does
not carry the authenticated session.

## How we will know it worked

- Constructing `createFetchApp` with `https://example.com` and `http://localhost:3000` succeeds,
  and a request with the matching Host reaches the route.
- A relative value and an absolute URL with a path are rejected at construction.
- An authenticated write without `Origin` succeeds under `allow-missing`.
- The Node adapter still rejects an authenticated write without `Origin`.
- An authenticated write with a different `Origin` still returns `origin_forbidden`.
- Each test is falsified by mutating the specific rule it names. Accepting every URL must break
  the invalid-origin tests, requiring every write to carry `Origin` must break the native-client
  test, and deleting the mismatch check must break the foreign-origin test.
- `pnpm build`, `pnpm exec tsc -b --force`, `pnpm exec biome check .`, and the full suite remain
  clean. Cross-package tests are trusted only after the build.

There is no deferral in this change, so it adds nothing to `BACKLOG.md`. README and ROADMAP need no
status change because this fixes a compatibility defect without changing the stated
scope or verification history.
