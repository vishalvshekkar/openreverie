import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppApi, Document, DocumentRow } from '../api.js'
import { Markdown } from './markdown.js'
import './journal.css'

const MAX_PAGES = 50

const METHOD_LABELS: Record<string, string> = {
  expressive_writing: 'Expressive Writing',
  gratitude: 'Gratitude',
  examen: 'Daily Examen',
  thought_record: 'CBT Thought Record',
  morning_pages: 'Morning Pages',
  open: 'Open format',
}

function methodLabel(method: string | undefined): string {
  if (!method) return 'Journal entry'
  return METHOD_LABELS[method] ?? method
}

function formatEntryDate(entryDate: string | undefined): string {
  if (!entryDate) return ''
  const date = new Date(`${entryDate}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return entryDate
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function formatRecordedAt(recordedAt: string | undefined): string | null {
  if (!recordedAt) return null
  const date = new Date(recordedAt)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date)
}

type ListStatus = 'loading' | 'ready' | 'error'

export function Journal({ api }: { api: AppApi }): JSX.Element {
  const [entries, setEntries] = useState<DocumentRow[]>([])
  const [listStatus, setListStatus] = useState<ListStatus>('loading')
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<Document | null>(null)
  const [entryError, setEntryError] = useState<string | null>(null)

  const selectEntry = useCallback(
    async (docId: string) => {
      setEntryError(null)
      try {
        const entry = await api.getDocument(docId)
        setSelectedEntry(entry)
        setSelectedDocId(docId)
      } catch {
        setEntryError('This entry could not be loaded. The previous one is still shown.')
      }
    },
    [api],
  )

  const loadEntries = useCallback(async () => {
    setListStatus('loading')
    try {
      const all: DocumentRow[] = []
      let cursor: string | undefined
      let pages = 0
      while (pages < MAX_PAGES) {
        const page = await api.listDocuments(cursor)
        all.push(...page.data)
        pages += 1
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
      setEntries(all.filter((row) => row.kind === 'journal'))
      setListStatus('ready')
    } catch {
      setListStatus('error')
    }
  }, [api])

  // biome-ignore lint/correctness/useExhaustiveDependencies: only ever run on mount, like Library's own loader
  useEffect(() => {
    void loadEntries()
  }, [])

  const sortedEntries = useMemo(
    () => entries.slice().sort((a, b) => (b.entryDate ?? '').localeCompare(a.entryDate ?? '')),
    [entries],
  )

  const recordedAtLine = formatRecordedAt(selectedEntry?.recordedAt)

  return (
    <div className="journal">
      <section className="journal-index" aria-label="Journal entries">
        {listStatus === 'loading' && <p className="journal-status">Loading journal entries.</p>}

        {listStatus === 'error' && (
          <p className="journal-status journal-status-error">
            <span>Journal entries could not be loaded.</span>
            <button type="button" onClick={() => void loadEntries()}>
              Retry
            </button>
          </p>
        )}

        {listStatus === 'ready' && sortedEntries.length === 0 && (
          <p className="journal-status">No journal entries yet.</p>
        )}

        {listStatus === 'ready' && sortedEntries.length > 0 && (
          <ul>
            {sortedEntries.map((row) => (
              <li key={row.docId}>
                <button
                  type="button"
                  aria-current={row.docId === selectedDocId}
                  onClick={() => void selectEntry(row.docId)}
                >
                  <span className="journal-row-method">{methodLabel(row.method)}</span>
                  <span className="journal-row-date">{formatEntryDate(row.entryDate)}</span>
                  {row.excerpt && <span className="journal-row-excerpt">{row.excerpt}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="journal-reading" aria-label="Entry">
        {entryError && <p className="journal-notice">{entryError}</p>}

        {selectedEntry ? (
          <article aria-label={methodLabel(selectedEntry.method)}>
            <header className="journal-reading-header">
              <p className="journal-meta">
                {methodLabel(selectedEntry.method)} &middot;{' '}
                {formatEntryDate(selectedEntry.entryDate)}
              </p>
              {recordedAtLine && <p className="journal-recorded-at">Written {recordedAtLine}</p>}
              <p className="journal-readonly-note">
                This entry is read-only. Add to it with a new entry instead.
              </p>
            </header>
            <div className="journal-body">
              <Markdown source={selectedEntry.body} />
            </div>
          </article>
        ) : (
          <p className="journal-empty">Pick an entry from the list to read it here.</p>
        )}
      </section>
    </div>
  )
}
