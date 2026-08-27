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

/*
 * Human labels for tool activity, one line per tool so a wording change
 * stays a one-line edit. Each entry carries a present-tense form for while
 * the tool is running and a past-tense form for once it has finished.
 * Wording and the fourteen tool names both come from packages/core's tool
 * catalogue (packages/core/src/tools.ts, toolDefinitions()); duplicated
 * here for the same reason MODE_OPTIONS is duplicated below: web talks to
 * server over HTTP only and never imports a runtime engine package, so this
 * cannot import that catalogue to stay in sync automatically. The parity
 * test in conversations.test.tsx is what notices this list drifting from
 * the fourteen tools that exist; it cannot detect tools.ts adding or
 * removing one on its own, so whoever changes toolDefinitions() must update
 * this table AND that test's hardcoded name list by hand, in the same
 * change (the same discipline graph-vocabulary-parity.test.ts documents for
 * NodeType/EdgeType).
 */
export const TOOL_LABELS: Record<string, { running: string; done: string }> = {
  remember: { running: 'Remembering', done: 'Remembered' },
  search_memory: { running: 'Searching memory', done: 'Searched memory' },
  graph_query: { running: 'Tracing connections', done: 'Traced connections' },
  read_document: { running: 'Reading back', done: 'Read that back' },
  read_transcript: { running: 'Reading a past conversation', done: 'Read a past conversation' },
  list_arcs: { running: 'Reviewing your storylines', done: 'Reviewed your storylines' },
  list_realms: { running: 'Reviewing your life areas', done: 'Reviewed your life areas' },
  list_people: { running: 'Looking over people', done: 'Looked over people' },
  list_entities: { running: 'Looking over things', done: 'Looked over things' },
  set_mode: { running: 'Switching mode', done: 'Switched mode' },
  update_profile: { running: 'Updating your profile', done: 'Updated your profile' },
  declare_journal_method: { running: 'Setting the journal format', done: 'Set the journal format' },
  update_journaling_protocol: {
    running: 'Updating your journal setup',
    done: 'Updated your journal setup',
  },
  dream_feedback: { running: 'Noting your reaction', done: 'Noted your reaction' },
}

// An unmapped tool name degrades to its own words (underscores to spaces)
// rather than a raw identifier, a blank line, or a crash.
function humanizeToolName(name: string): string {
  const words = name.split('_').filter(Boolean)
  return words.length === 0 ? 'a tool' : words.join(' ')
}

function toolRunningLabel(name: string): string {
  return TOOL_LABELS[name]?.running ?? `Using ${humanizeToolName(name)}`
}

function toolDoneLabel(name: string | undefined): string {
  if (name === undefined) return 'Tool result'
  return TOOL_LABELS[name]?.done ?? `Used ${humanizeToolName(name)}`
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

/*
 * Speaker attribution used to be a visible, absolutely positioned label in a
 * fixed-width left gutter, which overflowed for "reverie" (7 uppercase
 * characters plus tracking did not fit a 5rem box) and collided with
 * adjacent content. The redesign leans on layout instead: your messages are
 * right-aligned bubbles, reverie's replies are unlabelled full-width prose,
 * the way Claude and ChatGPT read. This label still exists, but only for
 * screen reader users, since the visual cue (alignment, bubble fill) is not
 * available to them.
 */
function speakerLabel(role: 'user' | 'assistant'): string {
  return role === 'user' ? 'You: ' : 'reverie: '
}

function renderMessage(message: ChatMessage) {
  if (message.role === 'user') {
    return (
      <div className="message message-user" key={message.id}>
        <p className="message-said">
          <span className="sr-only">{speakerLabel('user')}</span>
          {message.content}
        </p>
      </div>
    )
  }
  if (message.role === 'tool') {
    // Still in flight: nothing to disclose yet, so this renders as a plain,
    // non-interactive status chip rather than a <details> that would open
    // onto an empty payload. session.ts flips toolStatus to 'done' in place
    // (never deletes the message) the moment the call is known to have
    // finished, which is what turns this into the interactive chip below.
    if (message.toolStatus === 'running') {
      return (
        <div className="message message-tool" key={message.id}>
          <span className="tool-chip tool-chip-running">
            <span className="tool-chip-dot" aria-hidden="true" />
            <span aria-live="polite">{toolRunningLabel(message.toolName ?? '')}</span>
          </span>
        </div>
      )
    }
    // A completed tool call reads as a small, clearly interactive chip
    // (border, fill, caret, hover state), collapsed by default: the human
    // label only, never the raw JSON payload, which sits one click away.
    return (
      <div className="message message-tool" key={message.id}>
        <details className="tool-chip">
          <summary>
            <span aria-live="polite">{toolDoneLabel(message.toolName)}</span>
          </summary>
          <pre className="tool-chip-payload">{message.content}</pre>
        </details>
      </div>
    )
  }
  return (
    <div className="message message-assistant" key={message.id}>
      <p className="message-prose">
        <span className="sr-only">{speakerLabel('assistant')}</span>
        {message.content}
      </p>
    </div>
  )
}

/*
 * Duplicated in the browser rather than imported: web talks to server over
 * HTTP only and never imports a runtime engine package. This is a small,
 * stable piece of copy, and the test that counts ten entries is what
 * notices if the catalogue ever grows without this list following.
 *
 * Exported because it backs two pickers built from the same ten entries: the
 * mid-conversation mode switcher below, and the new-chat mode-card screen.
 * One source of truth, not a second list to keep in sync by hand.
 */
export const MODE_OPTIONS: readonly (readonly [string, string])[] = [
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

export function Conversations({
  api,
  preAuthenticated = false,
}: {
  api: AppApi
  // Set by App when the host has already established the session (Reverie
  // Cloud). Skips the self-hosted token exchange below entirely, rather
  // than relying on the absence of a ?token= URL param, so an unrelated
  // query param the host happens to use never gets misread as a bootstrap
  // token.
  preAuthenticated?: boolean
}): JSX.Element {
  const [state, dispatch] = useReducer(sessionReducer, initialChatState)
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [profile, setProfile] = useState<PublicProfile | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [highlightedMode, setHighlightedMode] = useState('general')
  const lastSequenceRef = useRef(0)
  const threadRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modeButtonRef = useRef<HTMLButtonElement>(null)
  const modeListRef = useRef<HTMLDivElement>(null)
  // Tracks which session the thread currently belongs to, independent of
  // React state timing, so a greeting stream started for a session that has
  // since been replaced (new conversation, opened a past one) can notice and
  // stop appending to the wrong thread.
  const activeSessionIdRef = useRef<string | null>(null)

  const refreshSessions = useCallback(async () => {
    try {
      const page = await api.listSessions()
      setSessions(page.data)
      setSessionsError(null)
    } catch {
      // The live thread must keep working even when the list cannot load.
      // The failure used to be swallowed silently here, which is exactly
      // what hid the mount-time race this replaced: surface it instead, with
      // a way to try again.
      setSessionsError('Conversations could not load.')
    }
  }, [api])

  // Called only from a mode-card click (or the falsification below), never on
  // mount: no session, and no POST /api/v1/sessions, until a card is chosen.
  const startSession = useCallback(
    async (mode: string) => {
      try {
        const session = await api.createSession(mode)
        lastSequenceRef.current = 0
        activeSessionIdRef.current = session.sessionId
        dispatch({ type: 'new-session', session })
        if (session.initialGreetingStreamUrl) {
          void streamGreeting(session.sessionId, api, dispatch, lastSequenceRef, activeSessionIdRef)
        }
      } catch {
        // A session may fail to start while past records stay browsable. The
        // person is left on the mode-card screen to try again.
      }
    },
    [api],
  )

  // Bootstrap (exchanging the URL token for the auth cookie) must finish
  // before the session list is fetched, or the fetch races ahead of the
  // cookie being set and comes back unauthenticated. The token is scrubbed
  // from the URL immediately, before the await, rather than after: a slow or
  // hung bootstrap should not leave a credential sitting in the address bar.
  //
  // A pre-authenticated host skips this whole step: there is no token to
  // read and no cookie to exchange for, the session already exists.
  useEffect(() => {
    void (async () => {
      if (!preAuthenticated) {
        const token = new URLSearchParams(window.location.search).get('token')
        if (token) {
          window.history.replaceState({}, '', window.location.pathname)
          try {
            await api.bootstrap(token)
          } catch {
            // Bootstrap is best effort at the token-exchange step itself. A
            // failure here still falls through to refreshSessions below, whose
            // own error state (and retry control) is what the person sees.
          }
        }
      }
      await refreshSessions()
    })()
  }, [api, refreshSessions, preAuthenticated])

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
  }, [state.messages, state.thinking])

  // Resizes the textarea's own DOM node, but must re-run on every keystroke
  // (draft change), not just when the ref identity changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on draft change, not ref identity
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  function closeModeMenu(refocus: boolean) {
    setModeMenuOpen(false)
    if (refocus) modeButtonRef.current?.focus()
  }

  function openModeMenu() {
    setHighlightedMode(state.mode)
    setModeMenuOpen(true)
  }

  // Focuses the open listbox and closes it on a click outside either the
  // button or the listbox itself. Scoped to modeMenuOpen only: closeModeMenu
  // is a plain function (not a stable useCallback), and re-running this on
  // every render would be wasteful for what is a straightforward open/close
  // lifecycle effect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally scoped to modeMenuOpen only
  useEffect(() => {
    if (!modeMenuOpen) return
    modeListRef.current?.focus()
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node
      if (modeListRef.current?.contains(target)) return
      if (modeButtonRef.current?.contains(target)) return
      closeModeMenu(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [modeMenuOpen])

  async function selectMode(mode: string) {
    closeModeMenu(true)
    if (mode !== state.mode) await changeMode(mode)
  }

  function handleModeMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const values = MODE_OPTIONS.map(([value]) => value)
    const index = values.indexOf(highlightedMode)
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setHighlightedMode(values[(index + 1) % values.length] ?? highlightedMode)
        break
      case 'ArrowUp':
        event.preventDefault()
        setHighlightedMode(values[(index - 1 + values.length) % values.length] ?? highlightedMode)
        break
      case 'Home':
        event.preventDefault()
        setHighlightedMode(values[0] ?? highlightedMode)
        break
      case 'End':
        event.preventDefault()
        setHighlightedMode(values[values.length - 1] ?? highlightedMode)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        void selectMode(highlightedMode)
        break
      case 'Escape':
        event.preventDefault()
        closeModeMenu(true)
        break
      default:
        break
    }
  }

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

  // Ends the prior session (best effort) and returns to the mode-card
  // screen, the same picker shown on first load. It does not start a new
  // session itself: that only happens once a card is clicked.
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
    activeSessionIdRef.current = null
    dispatch({ type: 'clear-session' })
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
  const sendDisabled = state.sending || draft.trim() === ''

  return (
    <div className="conversations">
      <nav className="session-rail" aria-label="Sessions">
        <div className="session-rail-header">
          <button type="button" className="new-conversation" onClick={() => void newChat()}>
            New conversation
          </button>
        </div>
        {sessionsError && (
          <div className="session-rail-error" role="alert">
            <p>{sessionsError}</p>
            <button type="button" onClick={() => void refreshSessions()}>
              Retry
            </button>
          </div>
        )}
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
        {state.session ? (
          <>
            <div className="thread-header">
              <div className="thread-header-primary">
                {!readOnly && (
                  <div className="mode-pill-wrap">
                    <button
                      type="button"
                      ref={modeButtonRef}
                      className="mode-pill"
                      aria-haspopup="listbox"
                      aria-expanded={modeMenuOpen}
                      onClick={() => (modeMenuOpen ? closeModeMenu(false) : openModeMenu())}
                    >
                      <span className="sr-only">Mode: </span>
                      {state.mode}
                    </button>
                    {modeMenuOpen && (
                      <div
                        className="mode-menu"
                        role="listbox"
                        aria-label="Mode"
                        tabIndex={-1}
                        ref={modeListRef}
                        aria-activedescendant={`mode-option-${highlightedMode}`}
                        onKeyDown={handleModeMenuKeyDown}
                      >
                        {MODE_OPTIONS.map(([value, summary]) => (
                          // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation is handled by the listbox's own onKeyDown above
                          // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the listbox; aria-activedescendant tracks the active option, the standard ARIA APG pattern for this widget
                          <div
                            key={value}
                            id={`mode-option-${value}`}
                            role="option"
                            aria-selected={value === state.mode}
                            className={
                              value === highlightedMode
                                ? 'mode-option mode-option-highlighted'
                                : 'mode-option'
                            }
                            onMouseEnter={() => setHighlightedMode(value)}
                            onClick={() => void selectMode(value)}
                          >
                            <span className="mode-option-name">{value}</span>
                            <span className="mode-option-summary">{summary}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {!readOnly && (
                  <span className="status-strip" data-testid="status-strip">
                    {webStatusStrip(profile, state.session.createdAt, nowMs)}
                  </span>
                )}
              </div>
              <div className="thread-header-secondary">
                <span className="thread-session-id" title={state.session.sessionId}>
                  {state.session.sessionId}
                </span>
                {!readOnly && (
                  <button type="button" className="end-conversation" onClick={() => void endChat()}>
                    End conversation
                  </button>
                )}
              </div>
            </div>
            <div className="thread" ref={threadRef} onScroll={handleThreadScroll}>
              <div className="thread-inner">
                {state.messages.map(renderMessage)}
                {state.messages.length === 0 && !state.thinking && !state.error && (
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
                {state.error && (
                  <p className="thread-notice" role="alert">
                    {state.error}
                  </p>
                )}
              </div>
            </div>

            <div className="composer-area">
              <div className="composer-area-inner">
                {readOnly ? (
                  <p className="composer-ended">
                    This conversation has ended. Start a new one to keep talking.
                  </p>
                ) : (
                  <form className="composer" onSubmit={handleSubmit}>
                    <div className="composer-surface">
                      <textarea
                        ref={textareaRef}
                        className="composer-input"
                        aria-label="Message"
                        placeholder="Say what is on your mind."
                        value={draft}
                        onChange={handleDraftChange}
                        onKeyDown={handleComposerKeyDown}
                        disabled={state.sending}
                        rows={3}
                      />
                      <button
                        type="submit"
                        className="send-button"
                        aria-label="Send"
                        disabled={sendDisabled}
                      >
                        <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
                          <path
                            d="M10 15.5V4.5M10 4.5L4.75 9.75M10 4.5L15.25 9.75"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="mode-picker-screen">
            <h2 className="mode-picker-screen-heading">Choose how to start</h2>
            <div className="mode-cards">
              {MODE_OPTIONS.map(([value, summary]) => (
                <button
                  type="button"
                  key={value}
                  className="mode-card"
                  onClick={() => void startSession(value)}
                >
                  <span className="mode-card-name">{value}</span>
                  <span className="mode-card-summary">{summary}</span>
                </button>
              ))}
            </div>
          </div>
        )}
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
