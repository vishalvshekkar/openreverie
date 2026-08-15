import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalJson, decodeCursor, encodeCursor, makeGraphSnapshot } from './api.js'

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

describe('canonical graph snapshots', () => {
  it('sorts object keys recursively and hashes the canonical folded graph bytes', () => {
    const snapshot = makeGraphSnapshot({
      nodes: [
        { id: 'node_b', type: 'person', label: 'B', assertedAt: '2026-08-15T10:00:00.000Z' },
        { id: 'node_a', type: 'person', label: 'A', assertedAt: '2026-08-15T10:00:00.000Z' },
      ],
      edges: [],
    })

    const bytes = Buffer.from(
      '{"edges":[],"nodes":[{"assertedAt":"2026-08-15T10:00:00.000Z","id":"node_a","label":"A","type":"person"},{"assertedAt":"2026-08-15T10:00:00.000Z","id":"node_b","label":"B","type":"person"}]}',
      'utf8',
    )
    expect(canonicalJson({ z: { b: 1, a: [true, null] }, a: 'first' })).toBe(
      '{"a":"first","z":{"a":[true,null],"b":1}}',
    )
    expect(snapshot).toMatchObject({
      revision: createHash('sha256').update(bytes).digest('hex'),
      nodes: [{ id: 'node_a' }, { id: 'node_b' }],
    })
  })
})
