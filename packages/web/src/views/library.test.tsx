import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AppApi, Document, DocumentRow } from '../api.js'
import { Library } from './Library.js'
import { Markdown, parseMarkdown, renderInline } from './markdown.js'

function row(overrides: Partial<DocumentRow> & Pick<DocumentRow, 'docId' | 'kind'>): DocumentRow {
  return {
    title: '',
    updatedAt: '2026-08-15T09:00:00.000Z',
    readOnly: true as const,
    ...overrides,
  }
}

function doc(overrides: Partial<Document> & Pick<Document, 'docId' | 'kind'>): Document {
  return {
    title: '',
    updatedAt: '2026-08-15T09:00:00.000Z',
    readOnly: true as const,
    body: '',
    ...overrides,
  }
}

const constitution = row({
  docId: 'doc_const_1',
  kind: 'constitution',
  title: 'Constitution',
  updatedAt: '2026-08-01T09:00:00.000Z',
})

const summaryPlaceholder = row({
  docId: 'doc_01KZZC9RZM56575G4T7962C',
  kind: 'summary',
  title: 'doc_01KZZC9RZM56575G4T7962C',
  updatedAt: '2026-08-14T18:00:00.000Z',
})

const dailyRollupPlaceholder = row({
  docId: 'doc_01KAAABBBCCC5575G4T7962',
  kind: 'rollup_daily',
  title: '',
  updatedAt: '2026-08-15T06:00:00.000Z',
})

const weeklyRollupPlaceholder = row({
  docId: 'doc_01KWEEKLY0000000000000A',
  kind: 'rollup_weekly',
  title: '',
  updatedAt: '2026-08-09T06:00:00.000Z',
})

const minaPerson = row({
  docId: 'doc_mina',
  kind: 'person',
  title: 'Mina',
  updatedAt: '2026-08-10T09:00:00.000Z',
})

const houseArc = row({
  docId: 'doc_house_arc',
  kind: 'arc',
  title: 'The house move',
  updatedAt: '2026-08-11T09:00:00.000Z',
})

function createApi(rows: DocumentRow[]): AppApi & { getDocument: ReturnType<typeof vi.fn> } {
  const documentsByDocId = new Map<string, Document>()
  for (const r of rows) {
    documentsByDocId.set(r.docId, doc({ ...r, body: `Body for ${r.docId}` }))
  }
  return {
    bootstrap: vi.fn(),
    createSession: vi.fn(),
    setSessionMode: vi.fn(),
    listSessions: vi.fn(),
    listDocuments: vi.fn().mockResolvedValue({ data: rows, nextCursor: null }),
    getDocument: vi.fn(async (docId: string) => {
      const found = documentsByDocId.get(docId)
      if (!found) throw new Error('not found')
      return found
    }),
    listProposals: vi.fn(),
    resolveProposal: vi.fn(),
    message: vi.fn(),
    events: vi.fn(),
    transcript: vi.fn(),
    end: vi.fn(),
    getGraphSnapshot: vi.fn(),
  } as unknown as AppApi & { getDocument: ReturnType<typeof vi.fn> }
}

describe('Library', () => {
  it('replaces a doc_01K... placeholder title with a derived human label, and leaves a real title alone', async () => {
    const api = createApi([constitution, summaryPlaceholder, minaPerson])
    render(<Library api={api} />)

    expect(await screen.findByRole('button', { name: 'Mina' })).toBeVisible()
    expect(
      await screen.findByRole('button', { name: 'Session summary, 14 August 2026' }),
    ).toBeVisible()
    expect(screen.queryByText('doc_01KZZC9RZM56575G4T7962C')).not.toBeInTheDocument()
  })

  it('groups documents under the expected human headings, in hierarchy order', async () => {
    const api = createApi([
      constitution,
      houseArc,
      minaPerson,
      dailyRollupPlaceholder,
      weeklyRollupPlaceholder,
      summaryPlaceholder,
    ])
    render(<Library api={api} />)

    await waitFor(() => expect(screen.getByLabelText('Document index')).toBeVisible())
    const headings = screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent)
    expect(headings).toEqual(['Constitution', 'Arcs', 'People', 'Rollups', 'Summaries'])

    const rollupsGroup = screen.getByLabelText('Rollups')
    expect(within(rollupsGroup).getByText('Daily rollup, 15 August 2026')).toBeVisible()
    expect(within(rollupsGroup).getByText('Weekly rollup, 9 August 2026')).toBeVisible()
  })

  it('selects the constitution by default and renders a chosen document body when clicked', async () => {
    const api = createApi([constitution, minaPerson])
    render(<Library api={api} />)

    expect(await screen.findByText('Body for doc_const_1')).toBeVisible()

    await userEvent.click(await screen.findByRole('button', { name: 'Mina' }))
    expect(await screen.findByText('Body for doc_mina')).toBeVisible()
    expect(screen.getByText('doc_mina')).toBeVisible()
  })

  it('narrows the index with the search input', async () => {
    const api = createApi([constitution, minaPerson, houseArc])
    render(<Library api={api} />)

    await screen.findByRole('button', { name: 'Mina' })
    await userEvent.type(screen.getByLabelText('Search'), 'mina')

    expect(screen.getByRole('button', { name: 'Mina' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'The house move' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Constitution' })).not.toBeInTheDocument()
  })

  it('shows a plain retry line when the list fails to load, and recovers on retry', async () => {
    const api = createApi([constitution])
    api.listDocuments = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ data: [constitution], nextCursor: null })

    render(<Library api={api} />)
    expect(await screen.findByText('The record could not be loaded.')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Constitution' })).toBeVisible()
  })

  it('leaves the previous document visible and shows a notice when a document load fails', async () => {
    const api = createApi([constitution, minaPerson])
    render(<Library api={api} />)
    await screen.findByText('Body for doc_const_1')

    api.getDocument.mockRejectedValueOnce(new Error('gone'))
    await userEvent.click(screen.getByRole('button', { name: 'Mina' }))

    expect(
      await screen.findByText(
        'This document could not be loaded. The previous one is still shown.',
      ),
    ).toBeVisible()
    expect(screen.getByText('Body for doc_const_1')).toBeVisible()
  })

  it('follows nextCursor pagination when listing documents', async () => {
    const api = createApi([constitution, minaPerson])
    api.listDocuments = vi
      .fn()
      .mockResolvedValueOnce({ data: [constitution], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ data: [minaPerson], nextCursor: null })

    render(<Library api={api} />)
    expect(await screen.findByRole('button', { name: 'Mina' })).toBeVisible()
    expect(api.listDocuments).toHaveBeenNthCalledWith(2, 'page-2')
  })
})

describe('markdown', () => {
  it('turns "# Heading" into a heading element', () => {
    render(<Markdown source="# Heading" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).toBeVisible()
  })

  it('leaves an unsupported construct (four hashes) as plain text', () => {
    render(<Markdown source="#### Not a heading" />)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.getByText('#### Not a heading')).toBeVisible()
  })

  it('renders a string containing <script> as literal text and creates no script element', () => {
    render(<Markdown source="Beware <script>alert(1)</script> in prose." />)
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByText('Beware <script>alert(1)</script> in prose.')).toBeVisible()
  })

  it('parses block structure directly', () => {
    const blocks = parseMarkdown(
      ['# Title', '', 'A paragraph.', '', '- one', '- two', '', '> a quote', '', '---'].join('\n'),
    )
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'paragraph', text: 'A paragraph.' },
      { type: 'list', ordered: false, items: ['one', 'two'] },
      { type: 'blockquote', text: 'a quote' },
      { type: 'hr' },
    ])
  })

  it('renders inline bold, italic, and code', () => {
    const nodes = renderInline('a **bold** and *italic* and `code`')
    expect(nodes.length).toBeGreaterThan(1)
  })
})
