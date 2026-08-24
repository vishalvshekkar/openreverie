// Markdown documents with YAML frontmatter, read and written atomically.
// This is the primitive every prose file in the memory folder is built on:
// realms, arcs, sessions, rollups, and the constitution itself.

import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { ulid } from 'ulid'

export type IdPrefix = 'doc' | 'item' | 'arc' | 'realm' | 'session' | 'person' | 'entity' | 'prop' | 'commitment'

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`
}

export interface DocumentMeta {
  id: string
  [key: string]: unknown
}

export interface Document {
  path: string
  meta: DocumentMeta
  body: string
}

// gray-matter throws its own YAML parser errors (e.g. an unterminated flow
// collection) with no file path in the message. Attributing that error to
// the path it came from is the difference between "reverie is broken" and
// "fix arcs/marathon.md line 3".
function parseFrontmatter(raw: string, path: string) {
  try {
    return matter(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Document at ${path} could not be parsed: ${message}`)
  }
}

export async function readDocument(path: string): Promise<Document> {
  const raw = await readFile(path, 'utf8')
  const parsed = parseFrontmatter(raw, path)
  const id = parsed.data.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Document at ${path} has no id in its frontmatter.`)
  }
  return {
    path,
    meta: parsed.data as DocumentMeta,
    body: parsed.content,
  }
}

export async function writeDocumentAtomic(doc: Document): Promise<void> {
  if (typeof doc.meta.id !== 'string' || doc.meta.id.length === 0) {
    throw new Error(`Cannot write document at ${doc.path}: meta is missing an id.`)
  }
  // Normalize body to end with exactly one trailing newline before serialization.
  // This ensures stored documents always have a single trailing newline regardless of input.
  const normalizedBody = doc.body.replace(/\n*$/, '\n')
  const serialized = matter.stringify(normalizedBody, doc.meta)
  const tmpPath = `${doc.path}.tmp-${ulid()}`
  await writeFile(tmpPath, serialized, 'utf8')
  await rename(tmpPath, doc.path)
}

// Skip-and-report, not abort-on-first-failure: a single hand-edited file
// with broken frontmatter must not make every caller of listDocuments
// (MemoryEngine.open among them) throw and take the whole CLI down with
// it, including the reindex command that would otherwise repair the
// index around the bad file. onSkip is called once per unreadable file,
// with its path and the reason readDocument rejected it, so a caller can
// surface that to the user instead of losing it silently.
export async function listDocuments(
  dir: string,
  onSkip?: (path: string, reason: string) => void,
): Promise<Document[]> {
  const entries = await readdir(dir)
  const mdFiles = entries.filter((e) => e.endsWith('.md')).sort()
  const docs: Document[] = []
  for (const file of mdFiles) {
    const path = join(dir, file)
    try {
      docs.push(await readDocument(path))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      onSkip?.(path, reason)
    }
  }
  return docs
}
