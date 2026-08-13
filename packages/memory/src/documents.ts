// Markdown documents with YAML frontmatter, read and written atomically.
// This is the primitive every prose file in the memory folder is built on:
// realms, arcs, sessions, rollups, and the constitution itself.

import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { ulid } from 'ulid'

export type IdPrefix = 'doc' | 'item' | 'arc' | 'realm' | 'session' | 'person' | 'prop'

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

export async function readDocument(path: string): Promise<Document> {
  const raw = await readFile(path, 'utf8')
  const parsed = matter(raw)
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

export async function listDocuments(dir: string): Promise<Document[]> {
  const entries = await readdir(dir)
  const mdFiles = entries.filter((e) => e.endsWith('.md')).sort()
  const docs: Document[] = []
  for (const file of mdFiles) {
    docs.push(await readDocument(join(dir, file)))
  }
  return docs
}
