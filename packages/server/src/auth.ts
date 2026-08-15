import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { ApiError } from './api.js'

export interface AuthDeps {
  origin: string
  now: () => number
  randomBytes: (size: number) => Buffer
  startedAt?: number
}

export interface BootstrapAuth {
  exchange(candidate: string): string
  authenticate(cookie: string | undefined): boolean
}

export function createBootstrapAuth(deps: AuthDeps): { token: string; auth: BootstrapAuth } {
  const token = deps.randomBytes(32).toString('base64url')
  const session = deps.randomBytes(32).toString('base64url')
  const startedAt = deps.startedAt ?? deps.now()
  let consumed = false

  return {
    token,
    auth: {
      exchange(candidate) {
        const valid =
          !consumed && deps.now() - startedAt <= 300_000 && timingSafeEqualText(candidate, token)
        if (!valid) throw new ApiError(401, 'unauthorized', 'Unauthorized.')
        consumed = true
        return session
      },
      authenticate(cookie) {
        return timingSafeEqualText(readCookie(cookie, 'reverie_session') ?? '', session)
      },
    },
  }
}

function timingSafeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function readCookie(cookie: string | undefined, name: string): string | undefined {
  if (!cookie) return undefined
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return undefined
}
