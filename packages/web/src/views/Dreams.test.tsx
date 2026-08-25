import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AppApi, DreamDetail, DreamRow, DreamStatus, DreamVerdict } from '../api.js'
import { Dreams, dreamStatusSummary } from './Dreams.js'

const notConfiguredStatus: DreamStatus = {
  configured: false,
  enabled: false,
  cadence: 'daily',
  period: '2026-08-25',
  periodCovered: false,
  reflectedSessionCount: 0,
  minReflectedSessions: 5,
  reflectedFloorMet: false,
  due: false,
}

function createApi(
  rows: DreamRow[],
  details: Record<string, DreamDetail> = {},
  status: DreamStatus = notConfiguredStatus,
): AppApi & {
  sendDreamFeedback: ReturnType<typeof vi.fn>
} {
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
    listDreams: vi.fn(async () => rows),
    getDream: vi.fn(async (dreamId: string) => {
      const found = details[dreamId]
      if (!found) throw new Error('not found')
      return found
    }),
    sendDreamFeedback: vi.fn(async () => undefined),
    getDreamStatus: vi.fn(async () => status),
  } as unknown as AppApi & { sendDreamFeedback: ReturnType<typeof vi.fn> }
}

const dreamRow1: DreamRow = {
  dreamId: 'dream_01A',
  date: '2026-08-20',
  period: '2026-08-20',
  hasNarrative: true,
  insightCount: 2,
}
const dreamRow2: DreamRow = {
  dreamId: 'dream_01B',
  date: '2026-08-22',
  period: '2026-08-22',
  hasNarrative: false,
  insightCount: 1,
}

const dreamDetail1: DreamDetail = {
  dreamId: 'dream_01A',
  date: '2026-08-20',
  period: '2026-08-20',
  narrative: 'A short piece of writing about the week just gone.',
  insights: [
    {
      insightId: 'ins_1',
      kind: 'pattern',
      headline: 'Evenings feel heavier lately',
      claim: 'Journal entries written after 8pm mention tiredness more than earlier ones.',
      confidence: 0.62,
    },
    {
      insightId: 'ins_2',
      kind: 'connection',
      headline: 'Coffee with Mina keeps coming up',
      claim: 'Several sessions mention meeting Mina for coffee as a steadying ritual.',
      confidence: 0.71,
    },
  ],
  processLog: 'seed: arc_01X\nwalk: arc_01X -> person_01Y\nwrote narrative\nwrote 2 insights',
}

const dreamDetail2: DreamDetail = {
  dreamId: 'dream_01B',
  date: '2026-08-22',
  period: '2026-08-22',
  insights: [
    {
      insightId: 'ins_3',
      kind: 'open_question',
      headline: 'Unclear how work stress connects to sleep',
      claim: 'Not enough evidence yet to say sleep quality tracks with work stress.',
      confidence: 0.4,
    },
  ],
  processLog: 'seed: arc_02Z\ntone check withheld the narrative',
}

describe('Dreams tab', () => {
  it('lists dreams newest first, showing date, insight count, and narrative status', async () => {
    const api = createApi([dreamRow1, dreamRow2])
    render(<Dreams api={api} />)
    const items = await screen.findAllByRole('button', { name: /August 2026/ })
    expect(items[0]).toHaveTextContent('22 August 2026')
    expect(items[0]).toHaveTextContent('1 insight')
    expect(items[0]).toHaveTextContent('No narrative')
    expect(items[1]).toHaveTextContent('20 August 2026')
    expect(items[1]).toHaveTextContent('2 insights')
    expect(items[1]).toHaveTextContent('Narrative')
  })

  it('opens a dream and shows the narrative and the insights as separate sections', async () => {
    const api = createApi([dreamRow1], { dream_01A: dreamDetail1 })
    render(<Dreams api={api} />)
    await userEvent.click(await screen.findByRole('button', { name: /20 August 2026/ }))
    await waitFor(() => expect(screen.getByText(/A short piece of writing/)).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Narrative' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Insights' })).toBeInTheDocument()
    expect(screen.getByText('Evenings feel heavier lately')).toBeInTheDocument()
    expect(screen.getByText(/mention tiredness more/)).toBeInTheDocument()
    expect(screen.getByText('62% confidence')).toBeInTheDocument()
  })

  it('shows the insights but says plainly that no narrative was written, without crashing', async () => {
    const api = createApi([dreamRow2], { dream_01B: dreamDetail2 })
    render(<Dreams api={api} />)
    await userEvent.click(await screen.findByRole('button', { name: /22 August 2026/ }))
    await waitFor(() =>
      expect(screen.getByText('No narrative was written for this dream.')).toBeInTheDocument(),
    )
    expect(screen.getByText('Unclear how work stress connects to sleep')).toBeInTheDocument()
  })

  it('sends the right verdict for the right insight and reflects it back once recorded', async () => {
    const api = createApi([dreamRow1], { dream_01A: dreamDetail1 })
    render(<Dreams api={api} />)
    await userEvent.click(await screen.findByRole('button', { name: /20 August 2026/ }))
    await screen.findByText('Evenings feel heavier lately')

    const feedbackGroups = screen.getAllByRole('group', { name: 'Feedback' })
    expect(feedbackGroups).toHaveLength(2)
    const [firstInsightFeedback, secondInsightFeedback] = feedbackGroups as [
      HTMLElement,
      HTMLElement,
    ]

    await userEvent.click(within(secondInsightFeedback).getByRole('button', { name: 'Wrong' }))

    await waitFor(() => expect(api.sendDreamFeedback).toHaveBeenCalledTimes(1))
    expect(api.sendDreamFeedback).toHaveBeenCalledWith('dream_01A', 'ins_2', 'wrong')

    await waitFor(() =>
      expect(within(secondInsightFeedback).getByRole('button', { name: 'Wrong' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(secondInsightFeedback.closest('.dreams-insight')).toHaveTextContent('Marked wrong.')

    // The first insight, which was never clicked, must show no verdict at all.
    expect(within(firstInsightFeedback).getByRole('button', { name: 'Right' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(within(firstInsightFeedback).getByRole('button', { name: 'Wrong' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(firstInsightFeedback.closest('.dreams-insight')).not.toHaveTextContent(/Marked/)
  })

  it('sends do_not_bring_up, not wrong, when that button is the one clicked', async () => {
    const api = createApi([dreamRow1], { dream_01A: dreamDetail1 })
    render(<Dreams api={api} />)
    await userEvent.click(await screen.findByRole('button', { name: /20 August 2026/ }))
    await screen.findByText('Evenings feel heavier lately')

    const [firstInsightFeedback] = screen.getAllByRole('group', { name: 'Feedback' }) as [
      HTMLElement,
    ]
    await userEvent.click(
      within(firstInsightFeedback).getByRole('button', { name: "Don't bring this up again" }),
    )

    await waitFor(() => expect(api.sendDreamFeedback).toHaveBeenCalledTimes(1))
    const verdict: DreamVerdict = 'do_not_bring_up'
    expect(api.sendDreamFeedback).toHaveBeenCalledWith('dream_01A', 'ins_1', verdict)
  })

  it('keeps the process log behind a details disclosure, rendered as preformatted lines', async () => {
    const api = createApi([dreamRow1], { dream_01A: dreamDetail1 })
    render(<Dreams api={api} />)
    await userEvent.click(await screen.findByRole('button', { name: /20 August 2026/ }))
    await screen.findByText('Evenings feel heavier lately')

    const summary = screen.getByText('Process log')
    const details = summary.closest('details')
    expect(details).not.toBeNull()
    expect(details).not.toHaveAttribute('open')
    const pre = details?.querySelector('pre')
    expect(pre?.textContent).toBe(dreamDetail1.processLog)
  })

  it('says dreaming has not run yet, without implying it is switched on', async () => {
    const api = createApi([])
    render(<Dreams api={api} />)
    const message = await screen.findByText(/Dreaming has not run yet/)
    expect(message).toHaveTextContent('off by default')
    expect(message).toHaveTextContent('config.toml')
    expect(message.textContent ?? '').not.toMatch(/is on\b/i)
  })

  it('has no edit, delete, or compose affordance anywhere', async () => {
    const api = createApi([dreamRow1], { dream_01A: dreamDetail1 })
    render(<Dreams api={api} />)
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /new dream|compose|write/i })).toBeNull()
  })
})

// Defect 4 (Dreams tab): the web previously had no honest interface for
// dreaming at all, so a person had no way to see whether it was on,
// whether it could run right now, or why the last attempt did not produce
// anything.
describe('Dreams tab status panel', () => {
  it('says plainly that dreaming is not configured at all, rather than showing nothing', async () => {
    const api = createApi([], {}, notConfiguredStatus)
    render(<Dreams api={api} />)
    const panel = await screen.findByLabelText('Dreaming status')
    expect(panel).toHaveTextContent('not configured')
  })

  it('reports disabled dreaming plainly, without implying it is on', async () => {
    const disabled: DreamStatus = { ...notConfiguredStatus, configured: true, enabled: false }
    const api = createApi([], {}, disabled)
    render(<Dreams api={api} />)
    const panel = await screen.findByLabelText('Dreaming status')
    expect(panel).toHaveTextContent('Dreaming is off')
    expect(panel).toHaveTextContent('enabled = true')
    expect(panel.textContent ?? '').not.toMatch(/is on\b/i)
  })

  it('reports enabled dreaming with the model, reflected sessions, and period coverage', async () => {
    const enabled: DreamStatus = {
      configured: true,
      enabled: true,
      cadence: 'daily',
      model: 'gpt-5',
      period: '2026-08-25',
      periodCovered: false,
      reflectedSessionCount: 46,
      minReflectedSessions: 5,
      reflectedFloorMet: true,
      due: true,
    }
    const api = createApi([], {}, enabled)
    render(<Dreams api={api} />)
    const panel = await screen.findByLabelText('Dreaming status')
    expect(panel).toHaveTextContent('Dreaming is on, daily')
    expect(panel).toHaveTextContent('gpt-5')
    expect(panel).toHaveTextContent('46/5')
    expect(panel).toHaveTextContent('due')
  })

  it('surfaces the last failed attempt, with its reason, distinctly from the rest of the panel', async () => {
    const enabled: DreamStatus = {
      configured: true,
      enabled: true,
      cadence: 'daily',
      model: 'gpt-5.6-luna',
      period: '2026-08-25',
      periodCovered: false,
      reflectedSessionCount: 46,
      minReflectedSessions: 5,
      reflectedFloorMet: true,
      due: true,
      lastAttempt: {
        ts: '2026-08-25T02:00:00.000Z',
        trigger: 'onStart',
        outcome: 'failed',
        reason: 'openai: HTTP 400: Function tools with reasoning_effort are not supported',
      },
    }
    const api = createApi([], {}, enabled)
    render(<Dreams api={api} />)
    const panel = await screen.findByLabelText('Dreaming status')
    const attempt = within(panel).getByRole('note')
    expect(attempt).toHaveTextContent('onStart')
    expect(attempt).toHaveTextContent('failed')
    expect(attempt).toHaveTextContent('Function tools with reasoning_effort are not supported')
  })

  it('does not break the dreams list when the status fetch itself fails', async () => {
    const api = createApi([dreamRow1])
    api.getDreamStatus = vi.fn(async () => {
      throw new Error('network error')
    })
    render(<Dreams api={api} />)
    await screen.findByRole('button', { name: /20 August 2026/ })
    expect(screen.queryByLabelText('Dreaming status')).toBeNull()
  })
})

describe('dreamStatusSummary', () => {
  it('is a single line saying dreaming is not configured, when it is not', () => {
    expect(dreamStatusSummary(notConfiguredStatus)).toEqual([
      'Dreaming is not configured on this server.',
    ])
  })

  it('names the reflected-session floor as the reason nothing has run when below it', () => {
    const belowFloor: DreamStatus = {
      configured: true,
      enabled: true,
      cadence: 'daily',
      model: 'gpt-5',
      period: '2026-08-25',
      periodCovered: false,
      reflectedSessionCount: 2,
      minReflectedSessions: 5,
      reflectedFloorMet: false,
      due: false,
    }
    const lines = dreamStatusSummary(belowFloor).join(' ')
    expect(lines).toContain('2/5')
    expect(lines).toContain('below the floor')
  })
})
