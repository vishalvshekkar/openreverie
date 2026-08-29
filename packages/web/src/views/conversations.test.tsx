import { readFileSync } from 'node:fs'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppApi, PublicProfile, Session, StreamEvent, TranscriptLine } from '../api.js'
import { Conversations, MODE_OPTIONS, TOOL_LABELS } from './Conversations.js'

const liveSessionId = 'session_01M052PA5A1MXY8JFHXTVVXAE'
const endedSessionId = 'session_01M052PA5A1MXY8JFHXTVVXAF'

// Timestamps are anchored to the local clock at test-run time (not a hardcoded
// date) so "Today" / "Yesterday" grouping keeps holding regardless of when the
// suite runs.
const now = new Date()
const todayAt = (hour: number, minute: number): string =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0).toISOString()
const yesterdayAt = (hour: number, minute: number): string => {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, minute, 0)
  return date.toISOString()
}

const liveSession: Session = {
  sessionId: liveSessionId,
  createdAt: todayAt(12, 0),
  updatedAt: todayAt(12, 0),
  status: 'live',
  readOnly: false,
  transcript: { lineCount: 0, userCount: 0, assistantCount: 0, toolCount: 0 },
  reflection: { state: 'not_started', attempts: 0 },
}

const endedSession: Session = {
  sessionId: endedSessionId,
  createdAt: yesterdayAt(9, 30),
  updatedAt: yesterdayAt(9, 31),
  status: 'ended',
  readOnly: true,
  transcript: { lineCount: 2, userCount: 1, assistantCount: 1, toolCount: 0 },
  reflection: { state: 'reflected', attempts: 1 },
}

const endedTranscript: TranscriptLine[] = [
  { lineSequence: 1, ts: yesterdayAt(9, 30), role: 'user', content: 'Hi from before' },
  {
    lineSequence: 2,
    ts: yesterdayAt(9, 31),
    role: 'assistant',
    content: 'A past reply',
  },
]

const text = (seq: number, value: string): StreamEvent => ({
  schemaVersion: '1',
  seq,
  type: 'text',
  text: value,
})
const done = (seq: number): StreamEvent => ({ schemaVersion: '1', seq, type: 'done' })
const errorEvent = (seq: number, message: string): StreamEvent => ({
  schemaVersion: '1',
  seq,
  type: 'error',
  code: 'chat_failed',
  retryable: true,
  message,
})

const defaultProfile: PublicProfile = {
  preferredName: null,
  pronouns: null,
  location: null,
  timezone: null,
  birthday: null,
  birthdayGreetings: null,
  occupation: null,
  style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
  prose: '',
}

// A stream that stays open until the test pushes into it, the same "gate"
// idiom the greeting tests below use, but reusable and named for the mode
// picker tests: no refetch happens when a mode event arrives mid-stream, so
// the test needs a stream it controls rather than one that settles on its own.
function makeControllableStream(): {
  stream: AsyncIterable<StreamEvent>
  push: (event: StreamEvent) => void
} {
  const pending: StreamEvent[] = []
  let notify: (() => void) | undefined
  async function* generator(): AsyncGenerator<StreamEvent> {
    for (;;) {
      const next = pending.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      await new Promise<void>((resolve) => {
        notify = resolve
      })
    }
  }
  return {
    stream: generator(),
    push(event: StreamEvent) {
      pending.push(event)
      notify?.()
      notify = undefined
    },
  }
}

function createApi() {
  return {
    bootstrap: vi.fn(),
    createSession: vi.fn(),
    setSessionMode: vi.fn(),
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
    getProfile: vi.fn(),
    updateProfile: vi.fn(),
    getSettings: vi.fn(),
  }
}

let api: ReturnType<typeof createApi>

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  api = createApi()
  api.bootstrap.mockResolvedValue({ authenticated: true })
  api.createSession.mockResolvedValue(liveSession)
  api.listSessions.mockResolvedValue({ data: [liveSession, endedSession], nextCursor: null })
  api.transcript.mockResolvedValue({ data: endedTranscript, nextCursor: null })
  api.end.mockResolvedValue({ ...liveSession, status: 'ended', readOnly: true })
  api.getProfile.mockResolvedValue(defaultProfile)
})

// Most of this file exercises an already-live session, so renderReady clicks
// the general mode card, the same first step a real visitor takes on the new
// mode-card screen, and waits for the session it starts.
async function renderReady() {
  render(<Conversations api={api as unknown as AppApi} />)
  const generalCard = await screen.findByRole('button', { name: /^general\b/i })
  await userEvent.click(generalCard)
  await waitFor(() => expect(api.createSession).toHaveBeenCalledWith('general'))
  return screen.getByLabelText('Message')
}

function modePillButton() {
  return screen.getByRole('button', { name: /^Mode: /i })
}

async function openModeMenu() {
  await userEvent.click(modePillButton())
  return screen.getByRole('listbox', { name: 'Mode' })
}

describe('Conversations', () => {
  it('keeps earlier messages visible after sending another one (the headline bug)', async () => {
    api.message.mockResolvedValueOnce([text(1, 'First reply'), done(2)])
    api.message.mockResolvedValueOnce([text(3, 'Second reply'), done(4)])

    const input = await renderReady()
    await userEvent.type(input, 'First message{enter}')
    expect(await screen.findByText('First reply')).toBeVisible()
    expect(screen.getByText('First message')).toBeVisible()

    await userEvent.type(input, 'Second message{enter}')
    expect(await screen.findByText('Second reply')).toBeVisible()

    expect(screen.getByText('First message')).toBeVisible()
    expect(screen.getByText('First reply')).toBeVisible()
    expect(screen.getByText('Second message')).toBeVisible()
  })

  it('coalesces two consecutive text events into a single assistant message', async () => {
    api.message.mockResolvedValueOnce([text(1, 'Hel'), text(2, 'lo'), done(3)])

    const input = await renderReady()
    await userEvent.type(input, 'Hi{enter}')

    expect(await screen.findByText('Hello')).toBeVisible()
    expect(screen.queryByText('Hel')).toBeNull()
    const assistantMessages = document.querySelectorAll('.message-assistant')
    expect(assistantMessages).toHaveLength(1)
  })

  it('shows the composer, Send, End conversation, and the mode pill for a live session', async () => {
    await renderReady()
    expect(screen.getByLabelText('Message')).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'End conversation' })).toBeInTheDocument()
    expect(modePillButton()).toBeInTheDocument()
  })

  it('shows only the ended notice for a read-only session: no textarea, no Send, no End conversation, no mode control', async () => {
    await renderReady()
    const pastEntry = await screen.findByTitle(endedSessionId)
    await userEvent.click(pastEntry)

    expect(await screen.findByText('A past reply')).toBeVisible()
    expect(
      screen.getByText('This conversation has ended. Start a new one to keep talking.'),
    ).toBeVisible()
    expect(screen.queryByLabelText('Message')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'End conversation' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Mode: /i })).toBeNull()
  })

  it('gives the send control an accessible name without visible text', async () => {
    await renderReady()
    const sendButton = screen.getByRole('button', { name: 'Send' })
    expect(sendButton).toHaveAttribute('aria-label', 'Send')
    expect(sendButton.textContent).toBe('')
  })

  it('loads and displays the transcript of a past session on click', async () => {
    await renderReady()
    const pastEntry = await screen.findByTitle(endedSessionId)
    await userEvent.click(pastEntry)

    await waitFor(() => expect(api.transcript).toHaveBeenCalledWith(endedSessionId))
    expect(await screen.findByText('Hi from before')).toBeVisible()
    expect(screen.getByText('A past reply')).toBeVisible()
  })

  it('renders a stream error as an inline notice and re-enables the composer', async () => {
    api.message.mockResolvedValueOnce([errorEvent(1, 'The stream broke.')])

    const input = await renderReady()
    await userEvent.type(input, 'Hi{enter}')

    const notice = await screen.findByRole('alert')
    expect(notice).toHaveTextContent('The stream broke.')
    await waitFor(() => expect(screen.getByLabelText('Message')).not.toBeDisabled())
  })

  it('sends on Enter and inserts a newline on Shift+Enter without sending', async () => {
    api.message.mockResolvedValueOnce([text(1, 'reply'), done(2)])

    const input = await renderReady()
    await userEvent.type(input, 'line one{Shift>}{enter}{/Shift}line two')

    expect(api.message).not.toHaveBeenCalled()
    expect(input).toHaveValue('line one\nline two')

    await userEvent.type(input, '{enter}')
    await waitFor(() => expect(api.message).toHaveBeenCalledTimes(1))
    expect(api.message).toHaveBeenCalledWith(
      liveSessionId,
      expect.any(String),
      'line one\nline two',
    )
  })

  it('ends the conversation from the thread header and shows the read-only view', async () => {
    await renderReady()
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }))

    await waitFor(() => expect(api.end).toHaveBeenCalledWith(liveSessionId))
    expect(
      await screen.findByText('This conversation has ended. Start a new one to keep talking.'),
    ).toBeVisible()
  })

  it('groups sessions under readable date headings, not raw ids as the primary label', async () => {
    await renderReady()
    expect(await screen.findByText('Today')).toBeVisible()
    expect(screen.getByText('Yesterday')).toBeVisible()
    const entry = screen.getByTitle(endedSessionId)
    expect(within(entry).getByText(/^\d{1,2}:\d{2}\s?(AM|PM)$/i)).toBeVisible()
  })

  it('does not render the raw session id as visible text in the session list', async () => {
    await renderReady()
    await screen.findByText('Yesterday')
    const rail = screen.getByLabelText('Sessions')
    expect(within(rail).queryByText(endedSessionId)).toBeNull()
    expect(within(rail).queryByText(liveSessionId)).toBeNull()
    expect(screen.getByTitle(endedSessionId)).toBeInTheDocument()
  })

  it('shows a plain empty state instead of a blank thread', async () => {
    await renderReady()
    expect(screen.getByText('Nothing here yet. Say what is on your mind.')).toBeVisible()

    const pastEntry = screen.getByTitle(endedSessionId)
    api.transcript.mockResolvedValueOnce({ data: [], nextCursor: null })
    await userEvent.click(pastEntry)
    expect(
      await screen.findByText('This conversation ended before anything was said.'),
    ).toBeVisible()
  })

  describe('the opening greeting', () => {
    it('streams into the thread as an assistant message after the session is created', async () => {
      api.createSession.mockResolvedValueOnce({
        ...liveSession,
        initialGreetingStreamUrl: `/api/v1/sessions/${liveSessionId}/events`,
      })
      api.events.mockResolvedValueOnce([text(1, 'Welcome back.'), done(2)])

      await renderReady()

      expect(await screen.findByText('Welcome back.')).toBeVisible()
      expect(api.events).toHaveBeenCalledWith(liveSessionId)
    })

    it('leaves the thread empty, shows no error, and keeps the composer enabled when the greeting stream rejects', async () => {
      api.createSession.mockResolvedValueOnce({
        ...liveSession,
        initialGreetingStreamUrl: `/api/v1/sessions/${liveSessionId}/events`,
      })
      api.events.mockRejectedValueOnce(new Error('the provider is unreachable'))

      const input = await renderReady()

      await waitFor(() => expect(api.events).toHaveBeenCalled())
      expect(screen.queryByRole('alert')).toBeNull()
      expect(input).not.toBeDisabled()
      expect(screen.getByText('Nothing here yet. Say what is on your mind.')).toBeVisible()
    })

    it('lets the user send a message while the greeting is still streaming', async () => {
      async function* slowGreeting() {
        yield text(1, 'Hello there.')
        await new Promise<never>(() => {
          // Never resolves: the greeting stays mid-stream for the life of the test.
        })
      }
      api.createSession.mockResolvedValueOnce({
        ...liveSession,
        initialGreetingStreamUrl: `/api/v1/sessions/${liveSessionId}/events`,
      })
      api.events.mockResolvedValueOnce(slowGreeting())
      api.message.mockResolvedValueOnce([text(3, 'reply'), done(4)])

      const input = await renderReady()
      expect(await screen.findByText('Hello there.')).toBeVisible()
      expect(input).not.toBeDisabled()

      await userEvent.type(input, 'Hi{enter}')
      await waitFor(() => expect(api.message).toHaveBeenCalledTimes(1))
      expect(await screen.findByText('reply')).toBeVisible()
    })

    it('abandons a stale greeting stream when the user starts a new conversation', async () => {
      const newSessionId = 'session_01M052PA5A1MXY8JFHXTVVXAG'
      const newSession: Session = {
        ...liveSession,
        sessionId: newSessionId,
      }
      let releaseOldGreeting: (() => void) | undefined
      const oldGreetingGate = new Promise<void>((resolve) => {
        releaseOldGreeting = resolve
      })
      // Sequence numbers deliberately outrun the new session's own greeting
      // (seq 1-2 below) so this event cannot be mistaken for a stale replay by
      // the reducer's own seq dedup: only the session-abandonment guard can be
      // the thing stopping it from landing in the new thread.
      async function* oldGreeting() {
        yield text(1, 'Old greeting first line')
        await oldGreetingGate
        yield text(100, 'Old greeting second line')
        yield done(101)
      }

      api.createSession.mockResolvedValueOnce({
        ...liveSession,
        initialGreetingStreamUrl: `/api/v1/sessions/${liveSessionId}/events`,
      })
      api.events.mockResolvedValueOnce(oldGreeting())

      await renderReady()
      expect(await screen.findByText('Old greeting first line')).toBeVisible()

      api.createSession.mockResolvedValueOnce({
        ...newSession,
        initialGreetingStreamUrl: `/api/v1/sessions/${newSessionId}/events`,
      })
      api.events.mockResolvedValueOnce([text(1, 'New greeting'), done(2)])
      api.listSessions.mockResolvedValue({
        data: [newSession, liveSession, endedSession],
        nextCursor: null,
      })

      const newConversation = screen.getByRole('button', { name: 'New conversation' })
      await userEvent.click(newConversation)

      // "New conversation" only returns to the mode-card screen now: the new
      // session (and its greeting) does not start until a card is clicked.
      const generalCard = await screen.findByRole('button', { name: /^general\b/i })
      await userEvent.click(generalCard)

      expect(await screen.findByText('New greeting')).toBeVisible()

      // Release the old greeting and let its remaining events actually settle
      // before asserting they never landed. A `waitFor` on a negative
      // assertion would pass on its very first (too-early) check regardless
      // of whether the abandon guard works, so this flushes deliberately: a
      // macrotask tick guarantees every pending microtask in the dispatch
      // chain has run first.
      await act(async () => {
        releaseOldGreeting?.()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(screen.queryByText('Old greeting second line')).toBeNull()
      expect(screen.getByText('New greeting')).toBeVisible()
    })
  })
})

describe('mount bootstrap ordering (the reload-to-see-sessions bug)', () => {
  it('does not list sessions until the token bootstrap has resolved', async () => {
    window.history.replaceState({}, '', '/?token=abc123')
    let resolveBootstrap: (() => void) | undefined
    const bootstrapGate = new Promise<{ authenticated: true }>((resolve) => {
      resolveBootstrap = () => resolve({ authenticated: true })
    })
    api.bootstrap.mockReturnValueOnce(bootstrapGate)

    render(<Conversations api={api as unknown as AppApi} />)

    await waitFor(() => expect(api.bootstrap).toHaveBeenCalledWith('abc123'))
    // The regression: listSessions used to fire in the same synchronous pass
    // as the fire-and-forget bootstrap call, racing ahead of the auth cookie
    // bootstrap sets and coming back 401 (swallowed silently by a blanket
    // catch). Asserting a call count of 0 here, before resolving the gate,
    // is what a "was eventually called" assertion would miss.
    expect(api.listSessions).not.toHaveBeenCalled()

    await act(async () => {
      resolveBootstrap?.()
      await bootstrapGate
    })

    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(1))
  })

  it('scrubs the token from the URL before bootstrap resolves, not after', async () => {
    window.history.replaceState({}, '', '/?token=abc123')
    let resolveBootstrap: (() => void) | undefined
    const bootstrapGate = new Promise<{ authenticated: true }>((resolve) => {
      resolveBootstrap = () => resolve({ authenticated: true })
    })
    api.bootstrap.mockReturnValueOnce(bootstrapGate)

    render(<Conversations api={api as unknown as AppApi} />)

    await waitFor(() => expect(api.bootstrap).toHaveBeenCalled())
    expect(window.location.search).toBe('')

    await act(async () => {
      resolveBootstrap?.()
      await bootstrapGate
    })
  })
})

describe('pre-authenticated host (Reverie Cloud)', () => {
  it('skips the token bootstrap and goes straight to the session list when told it is already authenticated', async () => {
    window.history.replaceState({}, '', '/?token=abc123')

    render(<Conversations api={api as unknown as AppApi} preAuthenticated={true} />)

    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(1))
    expect(api.bootstrap).not.toHaveBeenCalled()
  })

  it('leaves a stray token query param in the URL untouched, since it was never read as a bootstrap token', async () => {
    window.history.replaceState({}, '', '/?token=abc123')

    render(<Conversations api={api as unknown as AppApi} preAuthenticated={true} />)

    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(1))
    expect(window.location.search).toBe('?token=abc123')
  })
})

describe('session list failure', () => {
  it('shows a retry control when the session list fails to load, and recovers on retry', async () => {
    api.listSessions.mockReset()
    api.listSessions.mockRejectedValueOnce(new Error('network down'))

    render(<Conversations api={api as unknown as AppApi} />)

    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getByRole('alert')).toHaveTextContent('Conversations could not load.')

    api.listSessions.mockResolvedValueOnce({ data: [liveSession, endedSession], nextCursor: null })
    await userEvent.click(retry)

    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull())
  })
})

describe('mode picker', () => {
  it('shows the current mode name on the closed pill, not its description', async () => {
    await renderReady()
    const generalSummary = MODE_OPTIONS.find(([value]) => value === 'general')?.[1] ?? ''

    expect(modePillButton()).toHaveTextContent('general')
    expect(modePillButton()).not.toHaveTextContent(generalSummary)
  })

  it('lists all ten modes, with their descriptions, once opened', async () => {
    await renderReady()
    const listbox = await openModeMenu()
    const options = within(listbox).getAllByRole('option')
    expect(options).toHaveLength(10)
    expect(
      within(listbox).getByText('A concrete problem, worked toward real options and a decision.'),
    ).toBeVisible()
  })

  it('calls the session mode endpoint when a menu option is chosen', async () => {
    api.setSessionMode.mockResolvedValueOnce({ mode: 'listen' })
    await renderReady()
    const listbox = await openModeMenu()
    await userEvent.click(within(listbox).getByRole('option', { name: /^listen\b/i }))

    await waitFor(() => expect(api.setSessionMode).toHaveBeenCalledWith(liveSessionId, 'listen'))
    expect(modePillButton()).toHaveTextContent('listen')
  })

  it('follows the model without a refetch when a mode event arrives', async () => {
    const controllable = makeControllableStream()
    api.createSession.mockResolvedValueOnce({
      ...liveSession,
      initialGreetingStreamUrl: `/api/v1/sessions/${liveSessionId}/events`,
    })
    api.events.mockResolvedValueOnce(controllable.stream)

    await renderReady()
    expect(modePillButton()).toHaveTextContent('general')

    controllable.push({ schemaVersion: '1', seq: 1, type: 'mode', mode: 'solve' })
    await waitFor(() => expect(modePillButton()).toHaveTextContent('solve'))
    expect(api.setSessionMode).not.toHaveBeenCalled()
  })

  it('leaves the pill showing the old mode when the endpoint fails', async () => {
    api.setSessionMode.mockRejectedValueOnce(new Error('offline'))
    await renderReady()
    const listbox = await openModeMenu()
    await userEvent.click(within(listbox).getByRole('option', { name: /^listen\b/i }))

    await waitFor(() => expect(api.setSessionMode).toHaveBeenCalled())
    expect(modePillButton()).toHaveTextContent('general')
  })

  it('renders the status strip next to the mode pill in the thread header', async () => {
    await renderReady()
    expect(await screen.findByTestId('status-strip')).toHaveTextContent('warm')
  })

  it('opens with the current mode highlighted; Escape closes it and returns focus to the pill', async () => {
    await renderReady()
    const listbox = await openModeMenu()
    expect(listbox).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Mode' })).toBeNull()
    expect(modePillButton()).toHaveFocus()
  })

  it('selects an option by keyboard: ArrowDown then Enter', async () => {
    api.setSessionMode.mockResolvedValueOnce({ mode: 'listen' })
    await renderReady()
    await openModeMenu()

    await userEvent.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(api.setSessionMode).toHaveBeenCalledWith(liveSessionId, 'listen'))
  })

  it('closes when clicking outside the popover', async () => {
    await renderReady()
    await openModeMenu()
    expect(screen.getByRole('listbox', { name: 'Mode' })).toBeInTheDocument()

    await userEvent.click(document.body)
    expect(screen.queryByRole('listbox', { name: 'Mode' })).toBeNull()
  })
})

describe('the new-chat mode-card picker', () => {
  it('creates no session until a card is clicked, then creates it with the clicked mode', async () => {
    api.createSession.mockResolvedValueOnce({ ...liveSession, mode: 'solve' })

    render(<Conversations api={api as unknown as AppApi} />)

    const solveCard = await screen.findByRole('button', { name: /^solve\b/i })
    expect(api.createSession).not.toHaveBeenCalled()

    await userEvent.click(solveCard)

    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith('solve'))
  })

  it('shows all ten catalogue modes as cards, reusing the switcher copy', async () => {
    render(<Conversations api={api as unknown as AppApi} />)

    const heading = await screen.findByText('Choose how to start')
    const screenEl = heading.closest('.mode-picker-screen') as HTMLElement
    expect(within(screenEl).getAllByRole('button')).toHaveLength(10)
    expect(
      within(screenEl).getByText('A concrete problem, worked toward real options and a decision.'),
    ).toBeVisible()
  })

  it('leaves nothing to clean up if the picker screen is abandoned without a click', async () => {
    render(<Conversations api={api as unknown as AppApi} />)

    await screen.findByRole('button', { name: /^general\b/i })
    expect(api.createSession).not.toHaveBeenCalled()
    expect(api.end).not.toHaveBeenCalled()
  })

  it('shows the clicked mode, not a stale "general", once the session starts', async () => {
    api.createSession.mockResolvedValueOnce({ ...liveSession, mode: 'solve' })

    render(<Conversations api={api as unknown as AppApi} />)
    const solveCard = await screen.findByRole('button', { name: /^solve\b/i })
    await userEvent.click(solveCard)

    await waitFor(() => expect(modePillButton()).toHaveTextContent('solve'))
  })
})

describe('tool activity presentation', () => {
  it('shows a human label for a running tool, not the raw tool name', async () => {
    const controllable = makeControllableStream()
    api.message.mockResolvedValueOnce(controllable.stream)

    const input = await renderReady()
    await userEvent.type(input, 'Hi{enter}')
    controllable.push({ schemaVersion: '1', seq: 1, type: 'tool', name: 'remember' })

    expect(await screen.findByText('Remembering')).toBeVisible()
    expect(screen.queryByText('Using remember')).toBeNull()
    expect(screen.queryByText('remember', { exact: true })).toBeNull()
  })

  it('degrades an unrecognized tool name to a readable label instead of showing it raw', async () => {
    const controllable = makeControllableStream()
    api.message.mockResolvedValueOnce(controllable.stream)

    const input = await renderReady()
    await userEvent.type(input, 'Hi{enter}')
    controllable.push({ schemaVersion: '1', seq: 1, type: 'tool', name: 'some_unmapped_tool' })

    expect(await screen.findByText('Using some unmapped tool')).toBeVisible()
  })

  it('flips the chip to its done label and keeps it in the thread once the reply starts, instead of deleting it', async () => {
    const controllable = makeControllableStream()
    api.message.mockResolvedValueOnce(controllable.stream)

    const input = await renderReady()
    await userEvent.type(input, 'Hi{enter}')
    controllable.push({ schemaVersion: '1', seq: 1, type: 'tool', name: 'remember' })
    expect(await screen.findByText('Remembering')).toBeVisible()

    controllable.push({ schemaVersion: '1', seq: 2, type: 'text', text: 'Done.' })

    // The running label is gone, replaced in place by the done label, not
    // vanished the way the old "Using X" status line used to the instant
    // the first token of the reply arrived.
    await waitFor(() => expect(screen.queryByText('Remembering')).toBeNull())
    expect(screen.getByText('Remembered')).toBeVisible()
    expect(await screen.findByText('Done.')).toBeVisible()
  })

  it('shows the completed tool label collapsed, with the raw JSON payload hidden behind a disclosure', async () => {
    await renderReady()
    const pastEntry = await screen.findByTitle(endedSessionId)
    api.transcript.mockResolvedValueOnce({
      data: [
        ...endedTranscript,
        {
          lineSequence: 3,
          ts: yesterdayAt(9, 32),
          role: 'tool',
          content: '{"ok":true,"commitmentId":"commitment_01M0WDE8WSK20MDZFJHZPKHWHC"}',
        },
      ],
      nextCursor: null,
    })
    await userEvent.click(pastEntry)

    const summary = await screen.findByText('Tool result')
    const payload = screen.getByText(/"ok":true/)
    expect(payload).not.toBeVisible()

    await userEvent.click(summary)
    expect(payload).toBeVisible()
  })

  it('resolves a reopened tool result to its tool name (not the generic placeholder) from the preceding request line', async () => {
    await renderReady()
    const pastEntry = await screen.findByTitle(endedSessionId)
    api.transcript.mockResolvedValueOnce({
      data: [
        ...endedTranscript,
        {
          lineSequence: 3,
          ts: yesterdayAt(9, 32),
          role: 'assistant',
          content: 'Let me check.',
          toolCalls: [{ id: 'call_1', name: 'search_memory', arguments: '{}' }],
        },
        {
          lineSequence: 4,
          ts: yesterdayAt(9, 33),
          role: 'tool',
          content: '{"ok":true}',
          toolCallId: 'call_1',
        },
      ],
      nextCursor: null,
    })
    await userEvent.click(pastEntry)

    expect(await screen.findByText('Searched memory')).toBeVisible()
    expect(screen.queryByText('Tool result')).toBeNull()
  })

  it('suppresses an empty assistant announcement line that only carries a tool call, in a reopened session', async () => {
    await renderReady()
    const pastEntry = await screen.findByTitle(endedSessionId)
    api.transcript.mockResolvedValueOnce({
      data: [
        ...endedTranscript,
        {
          lineSequence: 3,
          ts: yesterdayAt(9, 32),
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'remember', arguments: '{}' }],
        },
        {
          lineSequence: 4,
          ts: yesterdayAt(9, 33),
          role: 'tool',
          content: '{"ok":true}',
          toolCallId: 'call_1',
        },
      ],
      nextCursor: null,
    })
    await userEvent.click(pastEntry)

    expect(await screen.findByText('Remembered')).toBeVisible()
    // No blank "reverie" bubble for the empty announcement line: exactly
    // the two persisted prose messages remain (the original transcript's
    // user line and assistant reply), plus the one tool chip above.
    expect(document.querySelectorAll('.message-assistant')).toHaveLength(1)
  })
})

// Hand mirrored the same way MODE_OPTIONS is (see Conversations.tsx's own
// comment above MODE_OPTIONS, and above TOOL_LABELS itself): web never
// imports a runtime engine package, so TOOL_LABELS cannot import
// packages/core/src/tools.ts's toolDefinitions() to compare against. This
// only catches TOOL_LABELS drifting from what is written here; it cannot
// detect toolDefinitions() adding or removing a tool on its own. Whoever
// changes toolDefinitions() must update TOOL_LABELS AND this list by hand,
// in the same change (the same discipline graph-vocabulary-parity.test.ts
// applies to NodeType/EdgeType).
const EXPECTED_TOOL_NAMES = [
  'remember',
  'search_memory',
  'graph_query',
  'read_document',
  'read_transcript',
  'list_arcs',
  'list_realms',
  'list_people',
  'list_entities',
  'set_mode',
  'update_profile',
  'declare_journal_method',
  'update_journaling_protocol',
  'dream_feedback',
]

describe('tool label catalogue parity with packages/core/src/tools.ts', () => {
  it('has exactly the fourteen tools in toolDefinitions(), each with a running and a done label', () => {
    expect(Object.keys(TOOL_LABELS).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort())
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(TOOL_LABELS[name]?.running).toBeTruthy()
      expect(TOOL_LABELS[name]?.done).toBeTruthy()
    }
  })

  // The test above compares this package's table against EXPECTED_TOOL_NAMES,
  // which is another hand-written list in this same file. That catches a table
  // edited without its own list, and nothing else: both halves live here, so
  // the pair can agree with each other while having drifted from core, which is
  // the only place the wording is actually decided. That is the "passes for a
  // reason unrelated to what it is named" shape AGENTS.md warns about.
  //
  // So this test reads packages/core/src/tool-labels.ts off disk and compares
  // the real strings. web cannot import @openreverie/core (it talks to server
  // over HTTP only and never imports a runtime engine package), so reading the
  // source text is the only way to assert against the actual canonical table
  // rather than against a copy of it. atlas.test.tsx does the same thing
  // against tokens.css for the same reason.
  it('matches the canonical table in packages/core/src/tool-labels.ts word for word', () => {
    const corePath = `${import.meta.dirname}/../../../core/src/tool-labels.ts`
    const source = readFileSync(corePath, 'utf8')

    const open = source.indexOf('const TOOL_LABELS')
    expect(open).toBeGreaterThan(-1)
    const braceStart = source.indexOf('{', open)
    let depth = 0
    let braceEnd = -1
    for (let index = braceStart; index < source.length; index++) {
      const char = source[index]
      if (char === '{') depth += 1
      if (char === '}') {
        depth -= 1
        if (depth === 0) {
          braceEnd = index
          break
        }
      }
    }
    expect(braceEnd).toBeGreaterThan(braceStart)

    // Collapsed to one line first: core formats short entries inline and long
    // ones across three lines, so a line-oriented match would silently skip
    // every multi-line entry and pass on a partial table.
    const body = source.slice(braceStart + 1, braceEnd).replace(/\s+/g, ' ')
    const entry = /(\w+):\s*\{\s*running:\s*'([^']*)',\s*done:\s*'([^']*)',?\s*\}/g
    const canonical: Record<string, { running: string; done: string }> = {}
    for (const match of body.matchAll(entry)) {
      const [, name, running, done] = match
      if (name !== undefined && running !== undefined && done !== undefined) {
        canonical[name] = { running, done }
      }
    }

    expect(Object.keys(canonical).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort())
    expect(TOOL_LABELS).toEqual(canonical)
  })
})

// The two accent tokens the tool chips are painted with. Every other colour in
// this view is monochrome ink on paper, so these are the only two that a theme
// block could drop without anything else looking wrong: a chip would fall back
// to an invalid custom property and inherit, in dark mode only, silently.
describe('tool accent tokens', () => {
  const tokens = readFileSync(`${import.meta.dirname}/../tokens.css`, 'utf8')

  // Brace counting rather than one regex over the whole file, for the same
  // reason atlas.test.tsx does it: tokens.css has two :root blocks (the light
  // one, and the one nested in @media (prefers-color-scheme: dark)), and a
  // single regex would match each variable's FIRST occurrence only, passing
  // even if the dark block had drifted or gone missing entirely.
  const blockAfter = (searchFrom: number): string => {
    const braceStart = tokens.indexOf('{', searchFrom)
    let depth = 0
    for (let index = braceStart; index < tokens.length; index++) {
      const char = tokens[index]
      if (char === '{') depth += 1
      if (char === '}') {
        depth -= 1
        if (depth === 0) return tokens.slice(braceStart + 1, index)
      }
    }
    throw new Error('unterminated block in tokens.css')
  }

  const lightBlock = blockAfter(tokens.indexOf(':root'))
  const darkBlock = blockAfter(
    tokens.indexOf(':root', tokens.indexOf('@media (prefers-color-scheme: dark)')),
  )

  const names = ['--tool-ink', '--tool-edge', '--tool-wash']

  it.each(names)('defines %s in the light theme', (name) => {
    const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(lightBlock)
    expect(match?.[1]).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it.each(names)('defines %s in the dark theme', (name) => {
    const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(darkBlock)
    expect(match?.[1]).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('gives the dark theme its own step for every accent, never the light hex', () => {
    for (const name of names) {
      const light = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(lightBlock)?.[1]
      const dark = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(darkBlock)?.[1]
      expect(dark).not.toBe(light)
    }
  })
})
