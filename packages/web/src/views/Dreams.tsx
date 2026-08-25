import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type {
  AppApi,
  DreamDetail,
  DreamInsight,
  DreamRow,
  DreamStatus,
  DreamVerdict,
} from '../api.js'
import { Markdown } from './markdown.js'
import './dreams.css'

const KIND_LABELS: Record<DreamInsight['kind'], string> = {
  pattern: 'Pattern',
  change_over_time: 'Change over time',
  connection: 'Connection',
  open_question: 'Open question',
  strength: 'Strength',
}

const VERDICT_NOTES: Record<DreamVerdict, string> = {
  right: 'Marked right.',
  wrong: 'Marked wrong.',
  do_not_bring_up: "Marked: don't bring this up again.",
}

function formatDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return isoDate
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function insightCountLabel(count: number): string {
  return count === 1 ? '1 insight' : `${count} insights`
}

function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}% confidence`
}

type ListStatus = 'loading' | 'ready' | 'error'

// A plain-language line per fact the 2026-08-25 dreaming investigation
// found nowhere to see: whether dreaming is on, what it will actually run
// on, whether it can run right now, and (via the caller checking
// lastAttempt separately) why the last real attempt did not leave a dream
// behind. Kept as a pure function so it is directly testable without
// rendering.
export function dreamStatusSummary(status: DreamStatus): string[] {
  if (!status.configured) {
    return ['Dreaming is not configured on this server.']
  }
  if (!status.enabled) {
    return [
      'Dreaming is off. Turn it on with enabled = true under [dreaming] in your config file, ' +
        'then restart reverie for the change to take effect.',
    ]
  }
  const lines: string[] = [
    `Dreaming is on, ${status.cadence}. Model: ${status.model ?? 'none configured'}.`,
    `Reflected sessions: ${status.reflectedSessionCount}/${status.minReflectedSessions}` +
      `${status.reflectedFloorMet ? '' : ' (below the floor; dreaming will not run yet)'}.`,
  ]
  lines.push(
    status.periodCovered
      ? `This period (${status.period}) already has a dream.`
      : status.due
        ? `This period (${status.period}) is due and has not run yet.`
        : `This period (${status.period}) has not run yet, and is not due (see reflected sessions above).`,
  )
  return lines
}

export function Dreams({ api }: { api: AppApi }): JSX.Element {
  const [rows, setRows] = useState<DreamRow[]>([])
  const [listStatus, setListStatus] = useState<ListStatus>('loading')
  const [status, setStatus] = useState<DreamStatus | null>(null)
  const [selectedDreamId, setSelectedDreamId] = useState<string | null>(null)
  const [selectedDream, setSelectedDream] = useState<DreamDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  const [pendingInsightId, setPendingInsightId] = useState<string | null>(null)

  const loadDreams = useCallback(async () => {
    setListStatus('loading')
    try {
      const all = await api.listDreams()
      setRows(all.slice().sort((a, b) => b.date.localeCompare(a.date)))
      setListStatus('ready')
    } catch {
      setListStatus('error')
    }
  }, [api])

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.getDreamStatus())
    } catch {
      // The dreams list itself still works without the status panel; a
      // failure here is shown as the panel simply not appearing, not as a
      // page-blocking error.
      setStatus(null)
    }
  }, [api])

  // biome-ignore lint/correctness/useExhaustiveDependencies: only ever run on mount, like Journal's own loader
  useEffect(() => {
    void loadDreams()
    void loadStatus()
  }, [])

  const selectDream = useCallback(
    async (dreamId: string) => {
      setDetailError(null)
      setFeedbackError(null)
      try {
        const dream = await api.getDream(dreamId)
        setSelectedDream(dream)
        setSelectedDreamId(dreamId)
      } catch {
        setDetailError('This dream could not be loaded. The previous one is still shown.')
      }
    },
    [api],
  )

  const submitFeedback = useCallback(
    async (insightId: string, verdict: DreamVerdict) => {
      if (!selectedDream) return
      setFeedbackError(null)
      setPendingInsightId(insightId)
      try {
        await api.sendDreamFeedback(selectedDream.dreamId, insightId, verdict)
        setSelectedDream((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                insights: prev.insights.map((insight) =>
                  insight.insightId === insightId ? { ...insight, verdict } : insight,
                ),
              },
        )
      } catch {
        setFeedbackError('That could not be recorded. Try again.')
      } finally {
        setPendingInsightId(null)
      }
    },
    [api, selectedDream],
  )

  return (
    <div className="dreams">
      <section className="dreams-index" aria-label="Dreams">
        {status !== null && (
          <section className="dreams-status-panel" aria-label="Dreaming status">
            {dreamStatusSummary(status).map((line) => (
              <p key={line} className="dreams-status-panel-line">
                {line}
              </p>
            ))}
            {status.lastAttempt !== undefined && (
              <p className="dreams-status-panel-attempt" role="note">
                The last attempt ({status.lastAttempt.trigger}, {status.lastAttempt.outcome}) did
                not produce a dream: {status.lastAttempt.reason}
              </p>
            )}
          </section>
        )}

        {listStatus === 'loading' && <p className="dreams-status">Loading dreams.</p>}

        {listStatus === 'error' && (
          <p className="dreams-status dreams-status-error">
            <span>Dreams could not be loaded.</span>
            <button type="button" onClick={() => void loadDreams()}>
              Retry
            </button>
          </p>
        )}

        {listStatus === 'ready' && rows.length === 0 && (
          <p className="dreams-status">
            Dreaming has not run yet. Dreaming is off by default, and it is turned on and scheduled
            in config.toml, not from here.
          </p>
        )}

        {listStatus === 'ready' && rows.length > 0 && (
          <ul>
            {rows.map((row) => (
              <li key={row.dreamId}>
                <button
                  type="button"
                  aria-current={row.dreamId === selectedDreamId}
                  onClick={() => void selectDream(row.dreamId)}
                >
                  <span className="dreams-row-date">{formatDate(row.date)}</span>
                  <span className="dreams-row-meta">
                    {insightCountLabel(row.insightCount)} &middot;{' '}
                    {row.hasNarrative ? 'Narrative' : 'No narrative'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dreams-reading" aria-label="Dream">
        {detailError && <p className="dreams-notice">{detailError}</p>}

        {selectedDream ? (
          <article aria-label={`Dream, ${formatDate(selectedDream.date)}`}>
            <header className="dreams-reading-header">
              <p className="dreams-meta">
                {formatDate(selectedDream.date)} &middot; {selectedDream.period}
              </p>
            </header>

            <section className="dreams-narrative" aria-label="Narrative">
              <h3>Narrative</h3>
              {selectedDream.narrative === undefined ? (
                <p className="dreams-no-narrative">No narrative was written for this dream.</p>
              ) : (
                <div className="dreams-narrative-body">
                  <Markdown source={selectedDream.narrative} />
                </div>
              )}
            </section>

            <section className="dreams-insights" aria-label="Insights">
              <h3>Insights</h3>
              {feedbackError && (
                <p className="dreams-notice" role="alert">
                  {feedbackError}
                </p>
              )}
              <ul>
                {selectedDream.insights.map((insight) => (
                  <li key={insight.insightId} className="dreams-insight">
                    <p className="dreams-insight-kind">{KIND_LABELS[insight.kind]}</p>
                    <p className="dreams-insight-headline">{insight.headline}</p>
                    <p className="dreams-insight-claim">{insight.claim}</p>
                    <p className="dreams-insight-confidence">
                      {confidenceLabel(insight.confidence)}
                    </p>
                    <fieldset className="dreams-insight-feedback" aria-label="Feedback">
                      <button
                        type="button"
                        aria-pressed={insight.verdict === 'right'}
                        disabled={pendingInsightId === insight.insightId}
                        onClick={() => void submitFeedback(insight.insightId, 'right')}
                      >
                        Right
                      </button>
                      <button
                        type="button"
                        aria-pressed={insight.verdict === 'wrong'}
                        disabled={pendingInsightId === insight.insightId}
                        onClick={() => void submitFeedback(insight.insightId, 'wrong')}
                      >
                        Wrong
                      </button>
                      <button
                        type="button"
                        aria-pressed={insight.verdict === 'do_not_bring_up'}
                        disabled={pendingInsightId === insight.insightId}
                        onClick={() => void submitFeedback(insight.insightId, 'do_not_bring_up')}
                      >
                        Don't bring this up again
                      </button>
                    </fieldset>
                    {insight.verdict && (
                      <p className="dreams-insight-verdict">{VERDICT_NOTES[insight.verdict]}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <details className="dreams-process-log">
              <summary>Process log</summary>
              <pre>{selectedDream.processLog}</pre>
            </details>
          </article>
        ) : (
          <p className="dreams-empty">Pick a dream from the list to read it here.</p>
        )}
      </section>
    </div>
  )
}
