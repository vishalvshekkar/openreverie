import type {
  ChangeEvent,
  Dispatch,
  FormEvent,
  JSX,
  KeyboardEvent,
  MutableRefObject,
  UIEvent,
} from 'react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  ApiHttpError,
  type AppApi,
  IncompleteStreamError,
  isTerminalEvent,
  type PublicProfile,
  type Session,
  type StreamEvent,
} from '../api.js'
import {
  type ChatAction,
  type ChatMessage,
  initialChatState,
  newTurnId,
  sessionReducer,
} from '../session.js'
import './conversations.css'

const SCROLL_STICK_THRESHOLD = 48

function isResyncRequired(error: unknown): boolean {
  return error instanceof ApiHttpError && error.status === 409 && error.code === 'resync_required'
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dateHeading(iso: string, now: Date): string {
  const date = new Date(iso)
  const day = startOfDay(date)
  const today = startOfDay(now)
  const oneDay = 24 * 60 * 60 * 1000
  if (day === today) return 'Today'
  if (day === today - oneDay) return 'Yesterday'
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  )
}

function formatLineCount(count: number): string {
  return `${count} line${count === 1 ? '' : 's'}`
}

interface SessionGroup {
  heading: string
  items: Session[]
}

function groupSessionsByDate(sessions: Session[], now: Date): SessionGroup[] {
  const groups: SessionGroup[] = []
  for (const session of sessions) {
    const heading = dateHeading(session.createdAt, now)
    const last = groups[groups.length - 1]
    if (last && last.heading === heading) last.items.push(session)
    else groups.push({ heading, items: [session] })
  }
  return groups
}

function roleLabel(role: ChatMessage['role']): string {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'reverie'
  return 'Tool'
}

async function consumeEvents(
  stream: AsyncIterable<StreamEvent>,
  dispatch: Dispatch<ChatAction>,
  lastSequenceRef: MutableRefObject<number>,
): Promise<boolean> {
  let terminal = false
  for await (const event of stream) {
    dispatch({ type: 'stream', event })
    lastSequenceRef.current = Math.max(lastSequenceRef.current, event.seq)
    if (isTerminalEvent(event)) terminal = true
  }
  return terminal
}

// Stops yielding as soon as the thread has moved on to a different session (a
// new conversation started, or a past one was opened) so a slow or
// still-streaming greeting can never append text into the wrong thread.
async function* guardedBySession(
  sessionId: string,
  stream: AsyncIterable<StreamEvent>,
  activeSessionIdRef: MutableRefObject<string | null>,
): AsyncGenerator<StreamEvent> {
  for await (const event of stream) {
    if (activeSessionIdRef.current !== sessionId) return
    yield event
  }
}

async function streamGreeting(
  sessionId: string,
  api: AppApi,
  dispatch: Dispatch<ChatAction>,
  lastSequenceRef: MutableRefObject<number>,
  activeSessionIdRef: MutableRefObject<string | null>,
): Promise<void> {
  try {
    const stream = await api.events(sessionId)
    await consumeEvents(
      guardedBySession(sessionId, stream, activeSessionIdRef),
      dispatch,
      lastSequenceRef,
    )
  } catch {
    // The greeting is best effort, the same way the CLI skips it silently.
    // A failed, timed-out, or unreachable greeting must still leave the
    // session open with an empty thread and a usable composer, not an error.
  }
}

function renderMessage(message: ChatMessage) {
  if (message.role === 'user') {
    return (
      <div className="message message-user" key={message.id}>
        <span className="message-meta">{roleLabel(message.role)}</span>
        <p className="message-said">{message.content}</p>
      </div>
    )
  }
  if (message.role === 'tool') {
    return (
      <div className="message message-tool" key={message.id}>
        <span className="message-meta">{roleLabel(message.role)}</span>
        <p className="message-tool-line">{message.content}</p>
      </div>
    )
  }
  return (
    <div className="message message-assistant" key={message.id}>
      <span className="message-meta">{roleLabel(message.role)}</span>
      <p className="message-prose">{message.content}</p>
    </div>
  )
}

/*
 * Duplicated in the browser rather than imported: web talks to server over
 * HTTP only and never imports a runtime engine package. This is a small,
 * stable piece of copy, and the test that counts ten entries is what
 * notices if the catalogue ever grows without this list following.
 */
const MODE_OPTIONS: readonly (readonly [string, string])[] = [
  ['general', 'Open conversation, no agenda.'],
  ['listen', 'You talk it through, it stays out of the way.'],
  ['solve', 'A concrete problem, worked toward real options and a decision.'],
  ['real', 'It pushes back and names what it sees.'],
  ['deep', 'It asks the questions, trying to understand you.'],
  ['brainstorm', 'Quantity over judgment, evaluation deferred.'],
  ['boost', 'Your corner talked up, from things it actually knows about you.'],
  ['decompress', 'Winding down. Light and low-stakes.'],
  ['process', 'Working through one specific thing until it settles.'],
  ['journal', 'Structured written reflection.'],
]

export function Conversations({ api }: { api: AppApi }): JSX.Element {
  const [state, dispatch] = useReducer(sessionReducer, initialChatState)
  const [sessions, setSessions] = useState<Session[]>([])
  const [draft, setDraft] = useState('')
  const [profile, setProfile] = useState<PublicProfile | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const lastSequenceRef = useRef(0)
  const threadRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Tracks which session the thread currently belongs to, independent of
  // React state timing, so a greeting stream started for a session that has
  // since been replaced (new conversation, opened a past one) can notice and
  // stop appending to the wrong thread.
  const activeSessionIdRef = useRef<string | null>(null)

  const refreshSessions = useCallback(async () => {
    try {
      const page = await api.listSessions()
      setSessions(page.data)
    } catch {
      // A failed session list must not block the live thread.
    }
  }, [api])

  const startSession = useCallback(async () => {
    try {
      const session = await api.createSession()
      lastSequenceRef.current = 0
      activeSessionIdRef.current = session.sessionId
      dispatch({ type: 'new-session', session })
      if (session.initialGreetingStreamUrl) {
        void streamGreeting(session.sessionId, api, dispatch, lastSequenceRef, activeSessionIdRef)
      }
    } catch {
      // A session may fail to start while past records stay browsable.
    }
  }, [api])

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token')
    if (token) {
      void api.bootstrap(token)
      window.history.replaceState({}, '', window.location.pathname)
    }
    void refreshSessions()
    void startSession()
  }, [api, refreshSessions, startSession])

  useEffect(() => {
    void (async () => {
      try {
        setProfile(await api.getProfile())
      } catch {
        // The strip degrades to nothing. A failed profile fetch must not
        // block the thread.
      }
    })()
  }, [api])

  useEffect(() => {
    const handle = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(handle)
  }, [])

  const changeMode = useCallback(
    async (mode: string) => {
      const sessionId = state.session?.sessionId
      if (sessionId === undefined) return
      try {
        await api.setSessionMode(sessionId, mode)
        dispatch({
          type: 'stream',
          event: { schemaVersion: '1', seq: state.lastSequence + 1, type: 'mode', mode },
        })
      } catch {
        // The picker stays where it was. A mode the server did not accept
        // must not be shown as if it took effect.
      }
    },
    [api, state.session?.sessionId, state.lastSequence],
  )

  // The effect scrolls the ref's current DOM node, but must re-run whenever
  // new content could have changed the thread's height, not just when the
  // ref itself changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on content change, not ref identity
  useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = threadRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [state.messages, state.thinking, state.activeTool])

  // Resizes the textarea's own DOM node, but must re-run on every keystroke
  // (draft change), not just when the ref identity changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on draft change, not ref identity
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  async function resync(sessionId: string) {
    const page = await api.transcript(sessionId)
    dispatch({ type: 'resync', lines: page.data })
  }

  async function reconnect(sessionId: string) {
    try {
      const stream = await api.events(sessionId, lastSequenceRef.current)
      const terminal = await consumeEvents(stream, dispatch, lastSequenceRef)
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
    const text = draft.trim()
    if (!session || session.readOnly || state.sending || text === '') return
    setDraft('')
    const turnId = newTurnId()
    dispatch({ type: 'turn-start', text })
    try {
      const stream = await api.message(session.sessionId, turnId, text)
      const terminal = await consumeEvents(stream, dispatch, lastSequenceRef)
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

  function handleDraftChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setDraft(event.target.value)
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  function handleThreadScroll(event: UIEvent<HTMLDivElement>) {
    const el = event.currentTarget
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < SCROLL_STICK_THRESHOLD
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
    stickToBottomRef.current = true
    await startSession()
    void refreshSessions()
  }

  async function endChat() {
    const current = state.session
    if (!current || current.readOnly) return
    try {
      const ended = await api.end(current.sessionId)
      lastSequenceRef.current = 0
      dispatch({ type: 'new-session', session: ended })
      void refreshSessions()
    } catch {
      // Ending the session is best effort.
    }
  }

  async function openSession(sessionId: string) {
    const target = sessions.find((item) => item.sessionId === sessionId)
    if (!target) return
    try {
      const page = await api.transcript(sessionId)
      lastSequenceRef.current = 0
      activeSessionIdRef.current = sessionId
      stickToBottomRef.current = true
      dispatch({ type: 'load-session', session: target, lines: page.data })
    } catch {
      // A failed load leaves the current thread untouched.
    }
  }

  const groups = groupSessionsByDate(sessions, new Date())
  const readOnly = state.session?.readOnly ?? false
  const composerDisabled = !state.session || state.sending || readOnly
  const sendDisabled = composerDisabled || draft.trim() === ''

  return (
    <div className="conversations">
      <nav className="session-rail" aria-label="Sessions">
        <div className="session-rail-header">
          <button type="button" className="new-conversation" onClick={() => void newChat()}>
            New conversation
          </button>
        </div>
        <div className="session-groups">
          {groups.map((group) => (
            <div className="session-group" key={group.heading}>
              <h3 className="session-date">{group.heading}</h3>
              <ul className="session-list">
                {group.items.map((session) => {
                  const active = state.session?.sessionId === session.sessionId
                  return (
                    <li key={session.sessionId}>
                      <button
                        type="button"
                        className={active ? 'session-entry session-entry-active' : 'session-entry'}
                        onClick={() => void openSession(session.sessionId)}
                        title={session.sessionId}
                        aria-current={active ? 'true' : undefined}
                      >
                        <span className="session-time">{formatTime(session.createdAt)}</span>
                        <span className="session-meta">
                          {formatLineCount(session.transcript.lineCount)} &middot; {session.status}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <section className="thread-column" aria-label="Conversation">
        {state.session && (
          <div className="thread-header">
            <span className="thread-session-id" title={state.session.sessionId}>
              {state.session.sessionId}
            </span>
          </div>
        )}
        <div className="thread" ref={threadRef} onScroll={handleThreadScroll}>
          <div className="thread-inner">
            {state.messages.map(renderMessage)}
            {state.messages.length === 0 &&
              !state.thinking &&
              !state.activeTool &&
              !state.error && (
                <p className="thread-empty">
                  {readOnly
                    ? 'This conversation ended before anything was said.'
                    : 'Nothing here yet. Say what is on your mind.'}
                </p>
              )}
            {state.thinking && (
              <p className="turn-status" aria-live="polite">
                Thinking
              </p>
            )}
            {state.activeTool && (
              <p className="turn-status" aria-live="polite">
                Using {state.activeTool}
              </p>
            )}
            {state.error && (
              <p className="thread-notice" role="alert">
                {state.error}
              </p>
            )}
          </div>
        </div>

        <div className="composer-area">
          <div className="composer-area-inner">
            <div className="composer-status">
              <label className="mode-picker" htmlFor="mode-picker">
                <span className="mode-picker-label">Mode</span>
                <select
                  id="mode-picker"
                  value={state.mode}
                  disabled={!state.session || readOnly}
                  onChange={(event) => void changeMode(event.target.value)}
                >
                  {MODE_OPTIONS.map(([value, summary]) => (
                    <option key={value} value={value}>
                      {value}: {summary}
                    </option>
                  ))}
                </select>
              </label>
              <span className="status-strip" data-testid="status-strip">
                {webStatusStrip(profile, state.session?.createdAt, nowMs)}
              </span>
            </div>
            {readOnly && (
              <p className="composer-note">
                This conversation has ended. Start a new one to keep talking.
              </p>
            )}
            <form className="composer" onSubmit={handleSubmit}>
              <textarea
                ref={textareaRef}
                className="composer-input"
                aria-label="Message"
                value={draft}
                onChange={handleDraftChange}
                onKeyDown={handleComposerKeyDown}
                disabled={composerDisabled}
                rows={1}
              />
              <div className="composer-controls">
                <button
                  type="button"
                  className="end-conversation"
                  onClick={() => void endChat()}
                  disabled={!state.session || readOnly}
                >
                  End conversation
                </button>
                <button type="submit" className="send-button" disabled={sendDisabled}>
                  Send
                </button>
              </div>
            </form>
          </div>
        </div>
      </section>
    </div>
  )
}

/*
 * The same four segments the terminal strip shows, from the same profile
 * fields: tone, local place and time, elapsed. Mode is the picker itself,
 * so it is not repeated here. A guessed timezone renders the time without
 * the place name; a zone the browser rejects drops the segment entirely
 * rather than substituting the host's, because a silent substitution is how
 * a wrong local time becomes invisible.
 */
function webStatusStrip(
  profile: PublicProfile | null,
  createdAt: string | undefined,
  nowMs: number,
): string {
  if (profile === null) return ''
  const segments: string[] = [profile.style.tone]

  if (profile.timezone !== null) {
    try {
      const time = new Intl.DateTimeFormat('en-US', {
        timeZone: profile.timezone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      }).format(new Date(nowMs))
      const place = profile.location === null ? '' : `${profile.location} `
      segments.push(`${place}${time}`)
    } catch {
      // A zone Intl rejects means no time segment at all.
    }
  }

  if (createdAt !== undefined) {
    const elapsed = Math.max(0, nowMs - new Date(createdAt).getTime())
    segments.push(`${Math.floor(elapsed / 60_000)}m`)
  }

  return segments.join(' · ')
}
