import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import { ApiHttpError, type AppApi, type StreamEvent, type TranscriptLine } from './api.js'

const sessionId = 'session-1'

const session = {
  sessionId,
  createdAt: '2026-08-15T12:00:00.000Z',
  updatedAt: '2026-08-15T12:00:00.000Z',
  status: 'live' as const,
  readOnly: false,
  transcript: { lineCount: 0, userCount: 0, assistantCount: 0, toolCount: 0 },
}

const minaDoc = {
  docId: 'doc-mina',
  kind: 'person' as const,
  title: 'Mina',
  updatedAt: '2026-08-15T12:00:00.000Z',
  readOnly: true as const,
}

const minaBody = 'Mina has been preparing for the move across town.'

const helloLine: TranscriptLine = {
  lineSequence: 1,
  ts: '2026-08-15T12:00:00.000Z',
  role: 'assistant',
  content: 'Hello',
}

const thinking = (seq: number): StreamEvent => ({ schemaVersion: '1', seq, type: 'thinking' })
const text = (seq: number, value: string): StreamEvent => ({
  schemaVersion: '1',
  seq,
  type: 'text',
  text: value,
})
const done = (seq: number): StreamEvent => ({ schemaVersion: '1', seq, type: 'done' })
const error = (
  seq: number,
  code: 'chat_unavailable' | 'chat_failed',
  message: string,
): StreamEvent => ({ schemaVersion: '1', seq, type: 'error', code, retryable: true, message })
const ndjson = (events: StreamEvent[]): StreamEvent[] => events

function createApi() {
  return {
    bootstrap: vi.fn(),
    createSession: vi.fn(),
    listSessions: vi.fn(),
    listDocuments: vi.fn(),
    getDocument: vi.fn(),
    listProposals: vi.fn(),
    resolveProposal: vi.fn(),
    message: vi.fn(),
    events: vi.fn(),
    transcript: vi.fn(),
    end: vi.fn(),
    getGraphSnapshot: vi.fn(),
  }
}

let api: ReturnType<typeof createApi>

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  api = createApi()
  api.bootstrap.mockResolvedValue({ authenticated: true })
  api.createSession.mockResolvedValue(session)
  api.listSessions.mockResolvedValue({ data: [], nextCursor: null })
  api.listDocuments.mockResolvedValue({ data: [minaDoc], nextCursor: null })
  api.getDocument.mockResolvedValue({ ...minaDoc, body: minaBody })
  api.listProposals.mockResolvedValue({ data: [], nextCursor: null })
  api.transcript.mockResolvedValue({ data: [helloLine], nextCursor: null })
  api.getGraphSnapshot.mockResolvedValue({ revision: 'a'.repeat(64), nodes: [], edges: [] })
})

describe('App', () => {
  it('bootstraps once, removes token from the address, and loads records with credentials', async () => {
    window.history.replaceState({}, '', '/?token=launch-token')
    render(<App api={api as unknown as AppApi} />)
    await waitFor(() => expect(api.bootstrap).toHaveBeenCalledWith('launch-token'))
    expect(window.location.search).toBe('')
    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeVisible()
  })

  it('reconnects from its last sequence and fetches transcript after resync_required', async () => {
    api.message.mockResolvedValueOnce(ndjson([thinking(1), text(2, 'Hello')]))
    api.events.mockRejectedValueOnce(new ApiHttpError(409, 'resync_required', 'Resync required.'))
    render(<App api={api as unknown as AppApi} />)
    await userEvent.type(screen.getByLabelText('Message'), 'Hi')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(api.events).toHaveBeenCalledWith(sessionId, 2))
    await waitFor(() => expect(api.transcript).toHaveBeenCalledWith(sessionId))
    expect(screen.getByText('Hello')).toBeVisible()
  })

  it('opens a document from the browser and makes provider outage honest', async () => {
    render(<App api={api as unknown as AppApi} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Mina' }))
    expect(await screen.findByRole('article', { name: 'Mina' })).toHaveTextContent(
      'Mina has been preparing',
    )
    api.message.mockResolvedValueOnce(
      ndjson([
        error(
          3,
          'chat_unavailable',
          'Chat is unavailable right now. Your saved record is still available.',
        ),
      ]),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(
      await screen.findByText(
        'Chat is unavailable right now. Your saved record is still available.',
      ),
    ).toBeVisible()
  })

  it('renders stream text as plain text, never as HTML markup', async () => {
    const payload = '<img src=x onerror="window.hacked=1">'
    api.message.mockResolvedValueOnce(ndjson([text(1, payload), done(2)]))
    render(<App api={api as unknown as AppApi} />)
    await userEvent.type(screen.getByLabelText('Message'), 'Hi')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(payload)).toBeVisible()
    expect(document.querySelector('img')).toBeNull()
  })
})
