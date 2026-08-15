import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createBootstrapAuth } from './auth.js'

describe('bootstrap authentication', () => {
  it('exchanges a launch token exactly once and authenticates its process-bound cookie', () => {
    const { token, auth } = createBootstrapAuth({
      origin: 'http://127.0.0.1:4312',
      now: () => 0,
      randomBytes: () => Buffer.alloc(32, 7),
    })

    const session = auth.exchange(token)

    expect(auth.authenticate(`other=value; reverie_session=${session}`)).toBe(true)
    expect(() => auth.exchange(token)).toThrowError(
      expect.objectContaining({ status: 401, code: 'unauthorized', message: 'Unauthorized.' }),
    )
  })

  it('rejects expired tokens with the same generic unauthorized response', () => {
    const { token, auth } = createBootstrapAuth({
      origin: 'http://127.0.0.1:4312',
      now: () => 300_001,
      startedAt: 0,
      randomBytes: () => Buffer.alloc(32, 7),
    })

    expect(() => auth.exchange(token)).toThrowError(
      expect.objectContaining({ status: 401, code: 'unauthorized', message: 'Unauthorized.' }),
    )
  })
})
