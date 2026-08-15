import { describe, expect, it } from 'vitest'
import type { StreamEvent, TranscriptLine } from './api.js'
import { initialChatState, newTurnId, sessionReducer } from './session.js'

const thinking = (seq: number): StreamEvent => ({ schemaVersion: '1', seq, type: 'thinking' })
const text = (seq: number, value: string): StreamEvent => ({
  schemaVersion: '1',
  seq,
  type: 'text',
  text: value,
})
const done = (seq: number): StreamEvent => ({ schemaVersion: '1', seq, type: 'done' })

const session = {
  sessionId: 'session-1',
  createdAt: '2026-08-15T12:00:00.000Z',
  updatedAt: '2026-08-15T12:00:00.000Z',
  status: 'live',
  readOnly: false,
  transcript: { lineCount: 0, userCount: 0, assistantCount: 0, toolCount: 0 },
} as const

const helloLine: TranscriptLine = {
  lineSequence: 1,
  ts: '2026-08-15T12:00:00.000Z',
  role: 'assistant',
  content: 'Hello',
}

describe('sessionReducer', () => {
  it('appends stream events and tracks the last sequence', () => {
    let state = sessionReducer(initialChatState, { type: 'stream', event: thinking(1) })
    state = sessionReducer(state, { type: 'stream', event: text(2, 'Hello') })
    expect(state.events).toHaveLength(2)
    expect(state.lastSequence).toBe(2)
    expect(state.sending).toBe(true)
  })

  it('stops sending on a terminal event', () => {
    let state = sessionReducer(initialChatState, { type: 'stream', event: text(1, 'Hi') })
    state = sessionReducer(state, { type: 'stream', event: done(2) })
    expect(state.sending).toBe(false)
  })

  it('does not append a reconnect event whose sequence is not after the last sequence', () => {
    let state = sessionReducer(initialChatState, { type: 'stream', event: text(2, 'Hello') })
    state = sessionReducer(state, { type: 'stream', event: text(1, 'stale') })
    state = sessionReducer(state, { type: 'stream', event: text(2, 'duplicate') })
    expect(state.events).toHaveLength(1)
    expect(state.lastSequence).toBe(2)
  })

  it('resync replaces transient events with the durable transcript', () => {
    let state = sessionReducer(initialChatState, { type: 'stream', event: text(2, 'Hello') })
    state = sessionReducer(state, { type: 'resync', lines: [helloLine] })
    expect(state.events).toHaveLength(0)
    expect(state.transcript).toEqual([helloLine])
    expect(state.sending).toBe(false)
  })

  it('new-session resets to a fresh state for the session', () => {
    let state = sessionReducer(initialChatState, { type: 'stream', event: text(2, 'Hello') })
    state = sessionReducer(state, { type: 'new-session', session })
    expect(state.session).toEqual(session)
    expect(state.events).toHaveLength(0)
    expect(state.lastSequence).toBe(0)
    expect(state.transcript).toBeNull()
    expect(state.sending).toBe(false)
  })

  it('generates a unique turn id for each send', () => {
    expect(newTurnId()).not.toBe(newTurnId())
  })
})
