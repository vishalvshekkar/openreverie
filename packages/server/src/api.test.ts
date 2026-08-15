import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from './api.js'

describe('API cursors', () => {
  it.each(['%', Buffer.from('{', 'utf8').toString('base64url')])(
    'maps malformed base64url or JSON cursor %j to cursor_invalid',
    (cursor) => {
      expect(() => decodeCursor(cursor, 'documents', 'documents-rev-1')).toThrowError(
        expect.objectContaining({ status: 400, code: 'cursor_invalid' }),
      )
    },
  )

  it('rejects wrong resource, wrong tuple schema, and stale revision', () => {
    const document = encodeCursor({
      v: 1,
      resource: 'documents',
      tuple: ['person', 'Mina', 'doc_1'],
      revision: 'documents-rev-1',
    })
    const malformedTuple = encodeCursor({
      v: 1,
      resource: 'documents',
      tuple: ['person', 'Mina'],
      revision: 'documents-rev-1',
    } as never)

    expect(() => decodeCursor(document, 'sessions', 'sessions-rev-1')).toThrowError(
      expect.objectContaining({ code: 'cursor_invalid' }),
    )
    expect(() => decodeCursor(malformedTuple, 'documents', 'documents-rev-1')).toThrowError(
      expect.objectContaining({ code: 'cursor_invalid' }),
    )
    expect(() => decodeCursor(document, 'documents', 'documents-rev-2')).toThrowError(
      expect.objectContaining({ code: 'cursor_invalid' }),
    )
  })
})
