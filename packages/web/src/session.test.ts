import { describe, expect, it } from 'vitest'
import type { StreamEvent, TranscriptLine } from './api.js'
import { initialChatState, messagesFromTranscript, newTurnId, sessionReducer } from './session.js'

const thinking = (seq: number): StreamEvent => ({ schemaVersion: '1', seq, type: 'thinking' })
const text = (seq: number, value: string): StreamEvent => ({
  schemaVersion: '1',
  seq,
  type: 'text',
  text: value,
})
const tool = (seq: number, name: string): StreamEvent => ({
  schemaVersion: '1',
  seq,
  type: 'tool',
  name,
})
const done = (seq: number): StreamEvent => ({ schemaVersion: '1', seq, type: 'done' })
const error = (seq: number, message: string): StreamEvent => ({
  schemaVersion: '1',
  seq,
  type: 'error',
  code: 'chat_failed',
  retryable: true,
  message,
})

const session = {
  sessionId: 'session-1',
  createdAt: '2026-08-15T12:00:00.000Z',
  updatedAt: '2026-08-15T12:00:00.000Z',
  status: 'live',
  readOnly: false,
  transcript: { lineCount: 0, userCount: 0, assistantCount: 0, toolCount: 0 },
  reflection: { state: 'not_started', attempts: 0 },
} as const

const helloLine: TranscriptLine = {
  lineSequence: 1,
  ts: '2026-08-15T12:00:00.000Z',
  role: 'assistant',
  content: 'Hello',
}

const userLine: TranscriptLine = {
  lineSequence: 2,
  ts: '2026-08-15T12:00:01.000Z',
  role: 'user',
  content: 'Hi there',
}

describe('sessionReducer', () => {
  it('turn-start appends a user message and keeps existing messages', () => {
    let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'first' })
    state = sessionReducer(state, { type: 'stream', event: text(1, 'reply') })
    state = sessionReducer(state, { type: 'stream', event: done(2) })
    state = sessionReducer(state, { type: 'turn-start', text: 'second' })

    expect(state.messages).toHaveLength(3)
    expect(state.messages[0]).toMatchObject({ role: 'user', content: 'first' })
    expect(state.messages[1]).toMatchObject({ role: 'assistant', content: 'reply', pending: false })
    expect(state.messages[2]).toMatchObject({ role: 'user', content: 'second' })
    expect(state.sending).toBe(true)
    expect(state.thinking).toBe(false)
    expect(state.error).toBeNull()
  })

  it('appends consecutive text events into a single pending assistant message', () => {
    let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'hi' })
    state = sessionReducer(state, { type: 'stream', event: text(1, 'Hel') })
    state = sessionReducer(state, { type: 'stream', event: text(2, 'lo') })

    const assistantMessages = state.messages.filter((message) => message.role === 'assistant')
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]?.content).toBe('Hello')
    expect(assistantMessages[0]?.pending).toBe(true)
  })

  it('starts a new pending assistant message when the trailing message is not pending', () => {
    let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'hi' })
    state = sessionReducer(state, { type: 'stream', event: text(1, 'first reply') })
    state = sessionReducer(state, { type: 'stream', event: done(2) })
    state = sessionReducer(state, { type: 'turn-start', text: 'again' })
    state = sessionReducer(state, { type: 'stream', event: text(3, 'second reply') })

    const assistantMessages = state.messages.filter((message) => message.role === 'assistant')
    expect(assistantMessages).toHaveLength(2)
    expect(assistantMessages[1]?.content).toBe('second reply')
    expect(assistantMessages[1]?.pending).toBe(true)
  })

  it('thinking event sets thinking true and creates no message', () => {
    let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'hi' })
    state = sessionReducer(state, { type: 'stream', event: thinking(1) })

    expect(state.thinking).toBe(true)
    expect(state.messages).toHaveLength(1)
  })

  describe('tool chips: appended running, flipped to done in place, never deleted', () => {
    it('a tool event appends a running chip; a following text event flips it to done and starts the reply', () => {
      let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'hi' })
      state = sessionReducer(state, { type: 'stream', event: thinking(1) })
      state = sessionReducer(state, { type: 'stream', event: tool(2, 'search_memory') })

      expect(state.messages).toHaveLength(2)
      expect(state.messages[1]).toMatchObject({
        role: 'tool',
        toolName: 'search_memory',
        toolStatus: 'running',
      })

      state = sessionReducer(state, { type: 'stream', event: text(3, 'found it') })

      expect(state.thinking).toBe(false)
      // The chip is still there, just flipped: this is the fix for the
      // vanishing-tool-line bug (packages/web/src/session.ts used to null
      // out a separate activeTool field the instant text arrived, with the
      // chip never having been a persistent message at all).
      expect(state.messages).toHaveLength(3)
      expect(state.messages[1]).toMatchObject({
        role: 'tool',
        toolName: 'search_memory',
        toolStatus: 'done',
      })
      expect(state.messages[2]).toMatchObject({
        role: 'assistant',
        content: 'found it',
        pending: true,
      })
    })

    it('a second tool event settles the first chip to done before appending its own running chip', () => {
      let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'hi' })
      state = sessionReducer(state, { type: 'stream', event: tool(1, 'search_memory') })
      state = sessionReducer(state, { type: 'stream', event: tool(2, 'remember') })

      expect(state.messages).toHaveLength(3)
      expect(state.messages[1]).toMatchObject({
        role: 'tool',
        toolName: 'search_memory',
        toolStatus: 'done',
      })
      expect(state.messages[2]).toMatchObject({
        role: 'tool',
        toolName: 'remember',
        toolStatus: 'running',
      })
    })

    it('done flips a still-running chip to done even with no text in between (a tool-only turn)', () => {
      let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'hi' })
      state = sessionReducer(state, { type: 'stream', event: tool(1, 'set_mode') })
      state = sessionReducer(state, { type: 'stream', event: done(2) })

      expect(state.messages).toHaveLength(2)
      expect(state.messages[1]).toMatchObject({
        role: 'tool',
        toolName: 'set_mode',
        toolStatus: 'done',
      })
    })

    it('error flips a still-running chip to done even when the stream drops mid-call', () => {
      let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'hi' })
      state = sessionReducer(state, { type: 'stream', event: tool(1, 'read_document') })
      state = sessionReducer(state, {
        type: 'stream',
        event: error(2, 'Chat could not finish. Please try again.'),
      })

      expect(state.messages[1]).toMatchObject({
        role: 'tool',
        toolName: 'read_document',
        toolStatus: 'done',
      })
    })
  })

  it('done finalises the trailing assistant message, flips a still-running tool chip, and clears transient flags', () => {
    let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'hi' })
    state = sessionReducer(state, { type: 'stream', event: tool(1, 'search_memory') })
    state = sessionReducer(state, { type: 'stream', event: text(2, 'answer') })
    state = sessionReducer(state, { type: 'stream', event: done(3) })

    const assistantMessage = state.messages.find((message) => message.role === 'assistant')
    expect(assistantMessage?.pending).toBe(false)
    const toolMessage = state.messages.find((message) => message.role === 'tool')
    expect(toolMessage?.toolStatus).toBe('done')
    expect(state.sending).toBe(false)
    expect(state.thinking).toBe(false)
  })

  it('error sets the error message, clears transient flags, and finalises a pending assistant message', () => {
    let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'hi' })
    state = sessionReducer(state, { type: 'stream', event: text(1, 'partial') })
    state = sessionReducer(state, { type: 'stream', event: error(2, 'The stream broke.') })

    const assistantMessage = state.messages.find((message) => message.role === 'assistant')
    expect(assistantMessage?.content).toBe('partial')
    expect(assistantMessage?.pending).toBe(false)
    expect(state.error).toBe('The stream broke.')
    expect(state.sending).toBe(false)
    expect(state.thinking).toBe(false)
  })

  it('ignores a stream event whose sequence is not after the last sequence, returning the identical state', () => {
    let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'hi' })
    state = sessionReducer(state, { type: 'stream', event: text(2, 'Hello') })
    const afterFirst = state
    state = sessionReducer(state, { type: 'stream', event: text(1, 'stale') })
    expect(state).toBe(afterFirst)
    state = sessionReducer(state, { type: 'stream', event: text(2, 'duplicate') })
    expect(state).toBe(afterFirst)
    expect(state.lastSequence).toBe(2)

    state = sessionReducer(state, { type: 'stream', event: text(3, ' more') })
    expect(state.lastSequence).toBe(3)
    expect(state).not.toBe(afterFirst)
  })

  it('resync replaces messages with the durable transcript and clears transient flags', () => {
    let state = sessionReducer(initialChatState, { type: 'new-session', session })
    state = sessionReducer(state, { type: 'turn-start', text: 'hi' })
    state = sessionReducer(state, { type: 'stream', event: thinking(1) })
    state = sessionReducer(state, { type: 'resync', lines: [helloLine, userLine] })

    expect(state.messages).toEqual(messagesFromTranscript([helloLine, userLine]))
    expect(state.sending).toBe(false)
    expect(state.thinking).toBe(false)
    expect(state.error).toBeNull()
    expect(state.session).toEqual(session)
  })

  it('load-session sets the session, replaces messages, and resets sequence and transient flags', () => {
    let state = sessionReducer(initialChatState, { type: 'stream', event: text(5, 'stray') })
    state = sessionReducer(state, {
      type: 'load-session',
      session,
      lines: [helloLine, userLine],
    })

    expect(state.session).toEqual(session)
    expect(state.messages).toEqual(messagesFromTranscript([helloLine, userLine]))
    expect(state.lastSequence).toBe(0)
    expect(state.sending).toBe(false)
    expect(state.thinking).toBe(false)
    expect(state.error).toBeNull()
  })

  it('new-session resets to initial state carrying only the new session', () => {
    let state = sessionReducer(initialChatState, { type: 'turn-start', text: 'hi' })
    state = sessionReducer(state, { type: 'stream', event: text(1, 'Hello') })
    state = sessionReducer(state, { type: 'new-session', session })

    expect(state).toEqual({ ...initialChatState, session })
  })

  it('clear-session drops the session entirely, back to the mode-card screen', () => {
    let state = sessionReducer(initialChatState, { type: 'new-session', session })
    state = sessionReducer(state, { type: 'turn-start', text: 'hi' })
    state = sessionReducer(state, { type: 'clear-session' })

    expect(state).toEqual(initialChatState)
    expect(state.session).toBeNull()
  })

  it('generates a unique turn id for each send', () => {
    expect(newTurnId()).not.toBe(newTurnId())
  })
})

describe('mode events', () => {
  it('starts in general', () => {
    expect(initialChatState.mode).toBe('general')
  })

  it('updates the mode from a stream event', () => {
    const next = sessionReducer(initialChatState, {
      type: 'stream',
      event: { schemaVersion: '1', seq: 1, type: 'mode', mode: 'listen' },
    })
    expect(next.mode).toBe('listen')
    expect(next.lastSequence).toBe(1)
  })

  it('ignores a mode event that is behind the sequence cursor', () => {
    const state = { ...initialChatState, lastSequence: 5, mode: 'listen' }
    const next = sessionReducer(state, {
      type: 'stream',
      event: { schemaVersion: '1', seq: 3, type: 'mode', mode: 'solve' },
    })
    expect(next.mode).toBe('listen')
  })

  it('resets to general on a new session that reports no mode of its own', () => {
    const state = { ...initialChatState, mode: 'journal' }
    const next = sessionReducer(state, { type: 'new-session', session })
    expect(next.mode).toBe('general')
  })

  it("adopts the new session's own mode when the session reports one", () => {
    const state = { ...initialChatState, mode: 'journal' }
    const next = sessionReducer(state, {
      type: 'new-session',
      session: { ...session, mode: 'solve' },
    })
    expect(next.mode).toBe('solve')
  })
})

describe('messagesFromTranscript', () => {
  it('maps role and content, marks messages not pending, and derives stable unique ids from lineSequence', () => {
    const messages = messagesFromTranscript([helloLine, userLine])

    expect(messages).toEqual([
      { id: expect.any(String), role: 'assistant', content: 'Hello', pending: false },
      { id: expect.any(String), role: 'user', content: 'Hi there', pending: false },
    ])
    expect(messages[0]?.id).not.toBe(messages[1]?.id)

    const again = messagesFromTranscript([helloLine, userLine])
    expect(again[0]?.id).toBe(messages[0]?.id)
    expect(again[1]?.id).toBe(messages[1]?.id)
  })

  it('resolves a tool result line to the name of the tool call that produced it', () => {
    const requestLine: TranscriptLine = {
      lineSequence: 1,
      ts: '2026-08-15T12:00:00.000Z',
      role: 'assistant',
      content: 'Let me check.',
      toolCalls: [{ id: 'call_1', name: 'search_memory', arguments: '{}' }],
    }
    const resultLine: TranscriptLine = {
      lineSequence: 2,
      ts: '2026-08-15T12:00:01.000Z',
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'call_1',
    }

    const messages = messagesFromTranscript([requestLine, resultLine])

    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: 'tool',
      content: '{"ok":true}',
      toolName: 'search_memory',
      toolStatus: 'done',
    })
  })

  it('leaves toolName undefined when the result carries a toolCallId with no matching request', () => {
    const resultLine: TranscriptLine = {
      lineSequence: 1,
      ts: '2026-08-15T12:00:00.000Z',
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'call_missing',
    }

    const messages = messagesFromTranscript([resultLine])

    expect(messages[0]).toMatchObject({ role: 'tool', toolStatus: 'done' })
    expect(messages[0]?.toolName).toBeUndefined()
  })

  it('drops an empty assistant announcement line that only carries a tool call, rather than rendering a blank bubble', () => {
    const firstRequest: TranscriptLine = {
      lineSequence: 1,
      ts: '2026-08-15T12:00:00.000Z',
      role: 'assistant',
      content: 'Let me check a couple of things.',
      toolCalls: [{ id: 'call_1', name: 'search_memory', arguments: '{}' }],
    }
    const secondRequest: TranscriptLine = {
      lineSequence: 2,
      ts: '2026-08-15T12:00:01.000Z',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_2', name: 'remember', arguments: '{}' }],
    }

    const messages = messagesFromTranscript([firstRequest, secondRequest])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Let me check a couple of things.',
    })
  })

  it('keeps a non-empty assistant line even when it also carries a tool call', () => {
    const requestLine: TranscriptLine = {
      lineSequence: 1,
      ts: '2026-08-15T12:00:00.000Z',
      role: 'assistant',
      content: 'One moment.',
      toolCalls: [{ id: 'call_1', name: 'search_memory', arguments: '{}' }],
    }

    const messages = messagesFromTranscript([requestLine])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'assistant', content: 'One moment.' })
  })
})
