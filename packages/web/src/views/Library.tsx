import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppApi, Document, DocumentRow } from '../api.js'
import { Markdown } from './markdown.js'
import './library.css'

// A defensive cap on pagination. The document count in a real memory folder
// is small; this only guards against a misbehaving server looping forever.
const MAX_PAGES = 50

type DocumentKind = DocumentRow['kind']

const KIND_LABELS: Record<DocumentKind, string> = {
  constitution: 'Constitution',
  realm: 'Realm',
  arc: 'Arc',
  person: 'Person',
  summary: 'Session summary',
  rollup_daily: 'Daily rollup',
  rollup_weekly: 'Weekly rollup',
}

function isPlaceholderTitle(title: string, docId: string): boolean {
  const trimmed = title.trim()
  if (trimmed === '') return true
  if (trimmed === docId) return true
  return /^doc_[0-9A-Z]+$/.test(trimmed)
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

// A row's stored title is what the memory folder actually carries. Summary
// and rollup files are named by generated doc id, not by anything a human
// wrote, so those ids leak into the title field. Detect that case client
// side and show a readable label instead, without ever touching the server.
export function displayTitle(
  row: Pick<DocumentRow, 'docId' | 'title' | 'kind' | 'updatedAt'>,
): string {
  if (!isPlaceholderTitle(row.title, row.docId)) return row.title
  return `${KIND_LABELS[row.kind]}, ${formatDate(row.updatedAt)}`
}

interface Group {
  key: string
  heading: string
  rows: DocumentRow[]
}

const GROUP_DEFS: { key: string; heading: string; kinds: DocumentKind[] }[] = [
  { key: 'constitution', heading: 'Constitution', kinds: ['constitution'] },
  { key: 'realms', heading: 'Realms', kinds: ['realm'] },
  { key: 'arcs', heading: 'Arcs', kinds: ['arc'] },
  { key: 'people', heading: 'People', kinds: ['person'] },
  { key: 'rollups', heading: 'Rollups', kinds: ['rollup_daily', 'rollup_weekly'] },
  { key: 'summaries', heading: 'Summaries', kinds: ['summary'] },
]

function groupDocuments(rows: DocumentRow[]): Group[] {
  return GROUP_DEFS.map((def) => ({
    key: def.key,
    heading: def.heading,
    rows: rows
      .filter((row) => def.kinds.includes(row.kind))
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  })).filter((group) => group.rows.length > 0)
}

type ListStatus = 'loading' | 'ready' | 'error'

export function Library({ api }: { api: AppApi }): JSX.Element {
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [listStatus, setListStatus] = useState<ListStatus>('loading')
  const [query, setQuery] = useState('')
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null)
  const [documentError, setDocumentError] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)

  const selectDocument = useCallback(
    async (docId: string) => {
      setDocumentError(null)
      try {
        const document = await api.getDocument(docId)
        setSelectedDocument(document)
        setSelectedDocId(docId)
      } catch {
        setDocumentError('This document could not be loaded. The previous one is still shown.')
      }
    },
    [api],
  )

  const loadDocuments = useCallback(async () => {
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
      setDocuments(all)
      setListStatus('ready')
      if (!initialized) {
        setInitialized(true)
        const constitution = all.find((row) => row.kind === 'constitution')
        if (constitution) void selectDocument(constitution.docId)
      }
    } catch {
      setListStatus('error')
    }
  }, [api, initialized, selectDocument])

  // Only ever run on mount. Retries are triggered explicitly by the user.
  // loadDocuments is intentionally left out of the dependency list: it is
  // recreated once initialization flips to true, and re-running the effect
  // then would issue a second, unwanted list request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    void loadDocuments()
  }, [])

  const filteredDocuments = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return documents
    return documents.filter((row) => displayTitle(row).toLowerCase().includes(needle))
  }, [documents, query])

  const groups = useMemo(() => groupDocuments(filteredDocuments), [filteredDocuments])

  return (
    <div className="library">
      <section className="library-index" aria-label="Document index">
        <div className="library-search">
          <label htmlFor="library-search-input">Search</label>
          <input
            id="library-search-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the record"
          />
        </div>

        {listStatus === 'loading' && <p className="library-status">Loading the record.</p>}

        {listStatus === 'error' && (
          <p className="library-status library-status-error">
            <span>The record could not be loaded.</span>
            <button type="button" onClick={() => void loadDocuments()}>
              Retry
            </button>
          </p>
        )}

        {listStatus === 'ready' && groups.length === 0 && (
          <p className="library-status">No documents match your search.</p>
        )}

        {listStatus === 'ready' &&
          groups.map((group) => (
            <section key={group.key} className="library-group" aria-label={group.heading}>
              <h3>{group.heading}</h3>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.docId}>
                    <button
                      type="button"
                      aria-current={row.docId === selectedDocId}
                      onClick={() => void selectDocument(row.docId)}
                    >
                      {displayTitle(row)}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </section>

      <section className="library-reading" aria-label="Reading pane">
        {documentError && <p className="library-notice">{documentError}</p>}

        {selectedDocument ? (
          <article aria-label={displayTitle(selectedDocument)}>
            <header className="library-reading-header">
              <p className="library-meta">
                {KIND_LABELS[selectedDocument.kind]} &middot;{' '}
                {formatDate(selectedDocument.updatedAt)}
              </p>
              <p className="library-docid">{selectedDocument.docId}</p>
              <p className="library-readonly-note">This document is read-only in this interface.</p>
            </header>
            <div className="library-body">
              <Markdown source={selectedDocument.body} />
            </div>
          </article>
        ) : (
          <p className="library-empty">
            Pick something from the record on the left to read it here.
          </p>
        )}
      </section>
    </div>
  )
}
