import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AppApi, Document, DocumentRow } from '../api.js'
import { Journal } from './Journal.js'

function createApi(
  rows: DocumentRow[],
  bodies: Record<string, string> = {},
): AppApi & { getDocument: ReturnType<typeof vi.fn> } {
  const documentsByDocId = new Map<string, Document>()
  for (const r of rows) {
    documentsByDocId.set(r.docId, { ...r, body: bodies[r.docId] ?? `Body for ${r.docId}` })
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

const gratitudeRow: DocumentRow = {
  docId: 'doc_01JAAA',
  kind: 'journal',
  title: 'doc_01JAAA',
  updatedAt: '2026-08-14T09:00:00.000Z',
  readOnly: true,
  method: 'gratitude',
  entryDate: '2026-08-14',
  excerpt: 'Grateful for a slow morning.',
  recordedAt: '2026-08-14T21:30:00.000Z',
}
const examenRow: DocumentRow = {
  docId: 'doc_01JBBB',
  kind: 'journal',
  title: 'doc_01JBBB',
  updatedAt: '2026-08-16T21:00:00.000Z',
  readOnly: true,
  method: 'examen',
  entryDate: '2026-08-16',
  excerpt: 'Tired but okay.',
}

describe('Journal tab', () => {
  it('lists entries sorted by entryDate descending, showing method in plain words, date, and excerpt', async () => {
    const api = createApi([gratitudeRow, examenRow])
    render(<Journal api={api} />)
    const items = await screen.findAllByRole('button', { name: /Daily Examen|Gratitude/ })
    expect(items[0]).toHaveTextContent('Daily Examen')
    expect(items[1]).toHaveTextContent('Gratitude')
    expect(screen.getByText(/Tired but okay\./)).toBeInTheDocument()
  })

  it('opens an entry showing its full body, method, entry date, and recordedAt as a secondary line', async () => {
    const api = createApi([gratitudeRow], {
      doc_01JAAA: 'Grateful for a slow morning.\n\nCoffee on the porch.\n',
    })
    render(<Journal api={api} />)
    await userEvent.click(await screen.findByRole('button', { name: /Gratitude/ }))
    await waitFor(() => expect(screen.getByText(/Coffee on the porch\./)).toBeInTheDocument())
    expect(screen.getByText('Gratitude · 14 August 2026')).toBeInTheDocument()
    expect(screen.getByText(/Written 14 August 2026/)).toBeInTheDocument()
  })

  it('has no edit, delete, or compose affordance anywhere', async () => {
    const api = createApi([gratitudeRow])
    render(<Journal api={api} />)
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /new entry|compose|write/i })).toBeNull()
  })
})
