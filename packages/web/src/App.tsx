import type { FormEvent } from 'react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  ApiHttpError,
  type AppApi,
  type Document,
  type DocumentRow,
  IncompleteStreamError,
  isTerminalEvent,
  type Proposal,
  type Session,
  type StreamEvent,
  type TranscriptLine,
} from './api.js'
import { initialChatState, newTurnId, sessionReducer } from './session.js'

function isResyncRequired(error: unknown): boolean {
  return error instanceof ApiHttpError && error.status === 409 && error.code === 'resync_required'
}

function transcriptLineLabel(role: TranscriptLine['role']): string {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'openreverie'
  return 'Tool'
}

function renderTranscriptLine(line: TranscriptLine) {
  return (
    <p className={`line line-${line.role}`} key={line.lineSequence}>
      <span className="line-role">{transcriptLineLabel(line.role)}: </span>
      {line.content}
    </p>
  )
}

function renderStreamEvent(event: StreamEvent) {
  switch (event.type) {
    case 'thinking':
      return (
        <p className="event event-thinking" key={event.seq}>
          Thinking.
        </p>
      )
    case 'text':
      return (
        <p className="event event-text" key={event.seq}>
          {event.text}
        </p>
      )
    case 'tool':
      return (
        <p className="event event-tool" key={event.seq}>
          Using {event.name}.
        </p>
      )
    case 'error':
      return (
        <p className="event event-error" key={event.seq}>
          {event.message}
        </p>
      )
    case 'done':
      return null
  }
}

function AtlasMountRegion() {
  return (
    <div className="atlas-mount-region">
      <h2>Atlas</h2>
      <p>The graph atlas will appear here in a later release.</p>
    </div>
  )
}

export function App({ api }: { api: AppApi }) {
  const [state, dispatch] = useReducer(sessionReducer, initialChatState)
  const [draft, setDraft] = useState('')
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [openDocument, setOpenDocument] = useState<Document | null>(null)
  const lastSequenceRef = useRef(0)

  const startSession = useCallback(async () => {
    try {
      const session = await api.createSession()
      lastSequenceRef.current = 0
      dispatch({ type: 'new-session', session })
    } catch {
      // A session may fail to start while records stay browsable.
    }
  }, [api])

  const loadRecords = useCallback(async () => {
    try {
      const [documentsPage, sessionsPage, proposalsPage] = await Promise.all([
        api.listDocuments(),
        api.listSessions(),
        api.listProposals(),
      ])
      setDocuments(documentsPage.data)
      setSessions(sessionsPage.data)
      setProposals(proposalsPage.data)
    } catch {
      // A failed record load must not block chat.
    }
  }, [api])

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token')
    if (token) {
      void api.bootstrap(token)
      window.history.replaceState({}, '', window.location.pathname)
    }
    void loadRecords()
    void startSession()
  }, [api, loadRecords, startSession])

  async function consumeEvents(stream: AsyncIterable<StreamEvent>): Promise<boolean> {
    let terminal = false
    for await (const event of stream) {
      dispatch({ type: 'stream', event })
      lastSequenceRef.current = Math.max(lastSequenceRef.current, event.seq)
      if (isTerminalEvent(event)) terminal = true
    }
    return terminal
  }

  async function resync(sessionId: string) {
    const page = await api.transcript(sessionId)
    dispatch({ type: 'resync', lines: page.data })
  }

  async function reconnect(sessionId: string) {
    try {
      const stream = await api.events(sessionId, lastSequenceRef.current)
      const terminal = await consumeEvents(stream)
      if (!terminal) await resync(sessionId)
    } catch (error) {
      if (isResyncRequired(error)) await resync(sessionId)
      else if (!(error instanceof IncompleteStreamError)) pushChatFailed()
    }
  }

  function pushChatFailed() {
    const seq = lastSequenceRef.current + 1
    const event: StreamEvent = {
      schemaVersion: '1',
      seq,
      type: 'error',
      code: 'chat_failed',
      retryable: true,
      message: 'Chat could not finish. Please try again.',
    }
    lastSequenceRef.current = seq
    dispatch({ type: 'stream', event })
  }

  async function send() {
    const session = state.session
    if (!session || session.readOnly || state.sending) return
    const text = draft
    setDraft('')
    const turnId = newTurnId()
    dispatch({ type: 'turn-start' })
    try {
      const stream = await api.message(session.sessionId, turnId, text)
      const terminal = await consumeEvents(stream)
      if (!terminal) await reconnect(session.sessionId)
    } catch (error) {
      if (error instanceof IncompleteStreamError) await reconnect(session.sessionId)
      else if (isResyncRequired(error)) await resync(session.sessionId)
      else pushChatFailed()
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    void send()
  }

  async function newChat() {
    const current = state.session
    if (current && !current.readOnly) {
      try {
        await api.end(current.sessionId)
      } catch {
        // Ending the prior session is best effort.
      }
    }
    await startSession()
  }

  async function endChat() {
    const current = state.session
    if (!current || current.readOnly) return
    try {
      const ended = await api.end(current.sessionId)
      lastSequenceRef.current = 0
      dispatch({ type: 'new-session', session: ended })
    } catch {
      // Ending the session is best effort.
    }
  }

  async function openDocumentById(docId: string) {
    try {
      setOpenDocument(await api.getDocument(docId))
    } catch {
      // A single document read must not crash the page.
    }
  }

  async function resolveProposal(proposal: Proposal, resolution: 'accepted' | 'rejected') {
    try {
      await api.resolveProposal(proposal.proposalId, resolution)
      setProposals((current) => current.filter((item) => item.proposalId !== proposal.proposalId))
    } catch {
      // A proposal resolution failure leaves the row in place.
    }
  }

  const statusText = state.sending
    ? 'Sending a message.'
    : state.events.some((event) => event.type === 'error')
      ? 'The message could not be completed.'
      : 'Ready.'

  return (
    <div className="app">
      <header className="app-header">
        <h1>openreverie</h1>
        <p className="stream-status" aria-live="polite">
          {statusText}
        </p>
      </header>
      <main className="app-main">
        <nav className="sessions" aria-label="Sessions">
          <h2>Sessions</h2>
          <div className="session-controls">
            <button type="button" onClick={() => void newChat()}>
              New chat
            </button>
            <button
              type="button"
              onClick={() => void endChat()}
              disabled={!state.session || state.session.readOnly}
            >
              End chat
            </button>
          </div>
          <ul className="session-list">
            {sessions.map((session) => (
              <li key={session.sessionId}>
                {session.sessionId} ({session.status})
              </li>
            ))}
          </ul>
        </nav>

        <section className="chat" aria-label="Chat">
          <div className="transcript">
            {(state.transcript ?? []).map(renderTranscriptLine)}
            {state.events.map(renderStreamEvent)}
          </div>
          <form className="composer" onSubmit={handleSubmit}>
            <label htmlFor="message-input">Message</label>
            <input
              id="message-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={state.sending}
              autoComplete="off"
            />
            <button type="submit" disabled={state.sending || (state.session?.readOnly ?? false)}>
              Send
            </button>
          </form>
        </section>

        <section className="documents" aria-label="Documents">
          <h2>Documents</h2>
          <ul className="document-list">
            {documents.map((document) => (
              <li key={document.docId}>
                <button type="button" onClick={() => void openDocumentById(document.docId)}>
                  {document.title}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="reader" aria-label="Reader">
          {openDocument && (
            <article className="document" aria-label={openDocument.title}>
              <h2>{openDocument.title}</h2>
              <div className="document-body">{openDocument.body}</div>
            </article>
          )}
        </section>

        <section className="proposals" aria-label="Proposals">
          <h2>Proposals</h2>
          {proposals.length === 0 ? (
            <p>No pending proposals.</p>
          ) : (
            <ul className="proposal-list">
              {proposals.map((proposal) => (
                <li key={proposal.proposalId}>
                  <span className="proposal-summary">{proposal.summary}</span>
                  <button type="button" onClick={() => void resolveProposal(proposal, 'accepted')}>
                    Accept
                  </button>
                  <button type="button" onClick={() => void resolveProposal(proposal, 'rejected')}>
                    Reject
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="atlas-mount" aria-label="Atlas">
          <AtlasMountRegion />
        </section>
      </main>
    </div>
  )
}
