// Classifies a document as point-in-time or living, for date filtering in
// the search index.
//
// A point-in-time document is about one bounded stretch of the person's
// life: a session summary, a daily rollup, a weekly rollup. Its span is
// stored in the index and an after/before filter compares against it.
//
// A living document (the constitution, and realm, arc and person pages) is
// rewritten over time and has no single date. It carries opened and updated
// in its frontmatter, and neither answers "when is this content about": an
// arc opened in January and rewritten in August passes after: 2026-08-01
// under updated and fails it under opened, and both readings are defensible,
// which is proof that neither is correct. File mtime is worse still, since
// it records when reflection last rewrote the page. So living documents get
// null, are stored with null date columns, and are never excluded by a date
// filter. That is a stated, tested property of exactly four kinds, not an
// accident that swallows most of the corpus.

import type { DocumentMeta } from './documents.js'
import { isoMondayOf, isoSundayOf } from './rollups.js'
import type { DocKind } from './sqlite.js'

export interface DateSpan {
  start: string
  end: string
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ISO_WEEK_PATTERN = /^\d{4}-W\d{2}$/

export function documentDateSpan(kind: DocKind, meta: DocumentMeta): DateSpan | null {
  switch (kind) {
    case 'summary':
    case 'rollup_daily': {
      const date = meta.date
      if (typeof date !== 'string' || !ISO_DATE_PATTERN.test(date)) {
        return null
      }
      return { start: date, end: date }
    }
    case 'rollup_weekly': {
      const week = meta.week
      if (typeof week !== 'string' || !ISO_WEEK_PATTERN.test(week)) {
        return null
      }
      return { start: isoMondayOf(week), end: isoSundayOf(week) }
    }
    case 'constitution':
    case 'realm':
    case 'arc':
    case 'person':
      return null
  }
}
