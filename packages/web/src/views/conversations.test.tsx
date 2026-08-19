import { act, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppApi, PublicProfile, Session, StreamEvent, TranscriptLine } from '../api.js'
import { Conversations } from './Conversations.js'

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
}

const endedSession: Session = {
  sessionId: endedSessionId,
  createdAt: yesterdayAt(9, 30),
  updatedAt: yesterdayAt(9, 31),
  status: 'ended',
  readOnly: true,
  transcript: { lineCount: 2, userCount: 1, assistantCount: 1, toolCount: 0 },
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

async function renderReady() {
  render(<Conversations api={api as unknown as AppApi} />)
  await waitFor(() => expect(api.createSession).toHaveBeenCalled())
  return screen.getByLabelText('Message')
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

  it('disables the composer for a read-only session and explains why', async () => {
    await renderReady()
    const pastEntry = await screen.findByTitle(endedSessionId)
    await userEvent.click(pastEntry)

    expect(await screen.findByText('A past reply')).toBeVisible()
    expect(
      screen.getByText('This conversation has ended. Start a new one to keep talking.'),
    ).toBeVisible()
    expect(screen.getByLabelText('Message')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
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

describe('mode picker', () => {
  it('lists ten modes and starts on general', async () => {
    await renderReady()
    const picker = screen.getByLabelText('Mode')
    expect(picker).toHaveValue('general')
    expect(picker.querySelectorAll('option')).toHaveLength(10)
  })

  it('calls the session mode endpoint when the picker changes', async () => {
    api.setSessionMode.mockResolvedValueOnce({ mode: 'listen' })
    await renderReady()
    const picker = screen.getByLabelText('Mode')
    await userEvent.selectOptions(picker, 'listen')
    await waitFor(() => expect(api.setSessionMode).toHaveBeenCalledWith(liveSessionId, 'listen'))
    expect(picker).toHaveValue('listen')
  })

  it('follows the model without a refetch when a mode event arrives', async () => {
    const controllable = makeControllableStream()
    api.createSession.mockResolvedValueOnce({
      ...liveSession,
      initialGreetingStreamUrl: `/api/v1/sessions/${liveSessionId}/events`,
    })
    api.events.mockResolvedValueOnce(controllable.stream)

    await renderReady()
    const picker = screen.getByLabelText('Mode')
    expect(picker).toHaveValue('general')

    controllable.push({ schemaVersion: '1', seq: 1, type: 'mode', mode: 'solve' })
    await waitFor(() => expect(screen.getByLabelText('Mode')).toHaveValue('solve'))
    expect(api.setSessionMode).not.toHaveBeenCalled()
  })

  it('leaves the picker where it was when the endpoint fails', async () => {
    api.setSessionMode.mockRejectedValueOnce(new Error('offline'))
    await renderReady()
    const picker = screen.getByLabelText('Mode')
    await userEvent.selectOptions(picker, 'listen')
    await waitFor(() => expect(api.setSessionMode).toHaveBeenCalled())
    expect(screen.getByLabelText('Mode')).toHaveValue('general')
  })

  it('renders the status strip next to the composer', async () => {
    await renderReady()
    expect(await screen.findByTestId('status-strip')).toHaveTextContent('warm')
  })
})
