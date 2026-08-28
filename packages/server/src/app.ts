// The node:http adapter over the transport-agnostic core in http-core.ts.
//
// Everything that actually decides what the /api/v1 contract does (route
// matching, request validation, response shaping) lives in http-core.ts and
// imports no node builtins. This file is the thin layer that is allowed to:
// building a Web-standard Request from an IncomingMessage, supplying a
// sha256 implementation from node:crypto, and serving static web assets
// from node:fs, since none of those three things exist in Workers and none
// of them belong in code a Workers host would also run.
//
// createApp's own contract (a node:http RequestListener) is unchanged from
// before this refactor: same signature, same behavior. Route bodies moved
// to http-core.ts unmodified, because node:http's ServerResponse already
// implements every member of http-core.ts's ResponseSink, so it is passed
// straight through with no wrapper.
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { ReverieConfig } from '@openreverie/core'
import { ApiError } from './api.js'
import type { BootstrapAuth } from './auth.js'
import {
  type CanonicalOrigin,
  type HandleDeps,
  type HashProvider,
  handle,
  parseCanonicalOrigin,
  type RecordEngine,
  type ResponseSink,
  toApiError,
  writeError,
} from './http-core.js'
import type { LiveSessionRegistry } from './registry.js'

export * from './http-core.js'

export interface CreateAppDeps {
  engine: RecordEngine
  auth: BootstrapAuth
  config?: ReverieConfig
  canonicalOrigin?: string
  origin?: string
  registry?: LiveSessionRegistry
  staticDir?: string
}

const nodeHash: HashProvider = {
  sha256(data) {
    return new Uint8Array(createHash('sha256').update(data).digest())
  },
}

export function createApp(deps: CreateAppDeps): RequestListener {
  const canonical = parseCanonicalOrigin(deps.origin ?? deps.canonicalOrigin ?? '')
  const proposalResolutionLocks = new Map<string, Promise<void>>()
  const staticDir = deps.staticDir
  const handleDeps: HandleDeps = {
    engine: deps.engine,
    auth: deps.auth,
    canonical,
    // Browsers are the only supported client of the self-hosted Node
    // adapter today, so preserve its existing requirement. A Web-standard
    // host must choose its policy explicitly when it constructs
    // createFetchApp.
    writeOriginPolicy: 'required',
    proposalResolutionLocks,
    registry: deps.registry,
    config: deps.config,
    hash: nodeHash,
    serveStatic: staticDir ? (sink, pathname) => serveStatic(sink, staticDir, pathname) : undefined,
    // The node:http adapter is the self-hosted product itself, so the
    // bootstrap-token cookie flow it has always exposed stays mounted
    // unconditionally, built from the same deps.auth every other route
    // authenticates against. See HandleDeps.bootstrap's own comment in
    // http-core.ts for why createFetchApp does not do this by default.
    bootstrap: deps.auth,
  }
  return (req, res) => {
    void handleNodeRequest(req, res, handleDeps).catch((error: unknown) => {
      writeError(res, toApiError(error))
    })
  }
}

async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  let request: Request
  try {
    request = nodeRequestToWebRequest(req)
  } catch {
    throw new ApiError(400, 'invalid_request', 'The request is invalid.')
  }
  // node:http's ServerResponse already has setHeader, writeHead, write,
  // end, once, off, and headersSent: exactly http-core.ts's ResponseSink.
  // No wrapper needed, which is the point of keeping ResponseSink to that
  // exact surface.
  await handle(request, res as ResponseSink, deps)
}

// Builds a Web-standard Request from an IncomingMessage. The host header
// becomes the Request's own authority rather than something read
// separately later: a Web Request always carries a full absolute URL, so
// this is the one place that has to assemble one from node:http's
// path-and-query-only req.url. A missing or empty host header falls back
// to a placeholder authority rather than leaving the URL unparseable, so a
// request with no Host header still reaches requireHost's own
// host_forbidden rejection instead of failing here with the wrong error
// code.
function nodeRequestToWebRequest(req: IncomingMessage): Request {
  const method = req.method ?? 'GET'
  const hostHeader = req.headers.host
  const base = hostHeader ? `http://${hostHeader}` : 'http://invalid.host'
  const url = `${base}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.set(key, value)
    }
  }
  const canHaveBody = method !== 'GET' && method !== 'HEAD'
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    ...(canHaveBody
      ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }
      : {}),
  }
  return new Request(url, init)
}

const staticContentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

async function serveStatic(sink: ResponseSink, staticDir: string, pathname: string): Promise<void> {
  const decoded = decodeURIComponent(pathname)
  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const extension = extname(requested).toLowerCase()
  const contentType = staticContentTypes[extension]

  if (requested !== 'index.html' && extension === '') {
    await serveStatic(sink, staticDir, '/')
    return
  }
  if (contentType === undefined)
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')

  try {
    const file = await resolveStaticFile(staticDir, requested)
    const contents = await readFile(file)
    sink.writeHead(200, {
      'content-type': contentType,
      'content-length': contents.byteLength,
      ...(requested === 'index.html' ? { 'cache-control': 'no-store' } : {}),
    })
    sink.end(contents)
  } catch (error) {
    if (!isMissingFile(error)) throw error
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }
}

async function resolveStaticFile(staticDir: string, requested: string): Promise<string> {
  const realStaticDir = await realpath(staticDir)
  const candidate = resolve(realStaticDir, requested)
  if (!isWithinDirectory(realStaticDir, candidate)) {
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }

  const realFile = await realpath(candidate)
  if (!isWithinDirectory(realStaticDir, realFile)) {
    throw new ApiError(404, 'not_found', 'The requested resource was not found.')
  }
  return realFile
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export type { CanonicalOrigin }
