import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type Document,
  listDocuments,
  newId,
  readDocument,
  writeDocumentAtomic,
} from './documents.js'
import { ensureMemoryTree, memoryPaths } from './paths.js'

describe('documents', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-memory-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('newId produces a prefixed ulid', () => {
    const id = newId('doc')
    expect(id).toMatch(/^doc_[0-9A-Z]{26}$/)
  })

  it('round-trips write and read, preserving meta and body', async () => {
    const path = join(dir, 'note.md')
    const doc: Document = {
      path,
      meta: { id: newId('doc'), title: 'A note' },
      body: 'This is the body of the note.\n',
    }
    await writeDocumentAtomic(doc)
    const read = await readDocument(path)
    expect(read.path).toBe(path)
    expect(read.meta).toEqual(doc.meta)
    expect(read.body).toBe(doc.body)
  })

  it('normalizes body without trailing newline to end with exactly one', async () => {
    const path = join(dir, 'note.md')
    const inputBody = 'This is the body without newline'
    const doc: Document = {
      path,
      meta: { id: newId('doc') },
      body: inputBody,
    }
    await writeDocumentAtomic(doc)
    const read = await readDocument(path)
    expect(read.body).toBe(`${inputBody}\n`)
  })

  it('normalizes body with multiple trailing newlines to end with exactly one', async () => {
    const path = join(dir, 'note.md')
    const inputBody = 'This is the body with multiple newlines\n\n\n'
    const doc: Document = {
      path,
      meta: { id: newId('doc') },
      body: inputBody,
    }
    await writeDocumentAtomic(doc)
    const read = await readDocument(path)
    expect(read.body).toBe('This is the body with multiple newlines\n')
  })

  it('writes atomically, leaving no .tmp- files behind', async () => {
    const path = join(dir, 'note.md')
    const doc: Document = {
      path,
      meta: { id: newId('doc') },
      body: 'body text',
    }
    await writeDocumentAtomic(doc)
    const entries = await readdir(dir)
    expect(entries).toEqual(['note.md'])
    expect(entries.some((e) => e.includes('.tmp-'))).toBe(false)
  })

  it('rejects a write when meta lacks an id', async () => {
    const path = join(dir, 'note.md')
    const doc = { path, meta: {}, body: 'body' } as unknown as Document
    await expect(writeDocumentAtomic(doc)).rejects.toThrow()
  })

  it('throws a plain error naming the path when frontmatter lacks id', async () => {
    const path = join(dir, 'bad.md')
    await writeFile(path, '---\ntitle: no id here\n---\nbody\n', 'utf8')
    await expect(readDocument(path)).rejects.toThrow(path)
  })

  it('listDocuments returns sorted docs and ignores non-md files', async () => {
    const pathB = join(dir, 'b.md')
    const pathA = join(dir, 'a.md')
    await writeDocumentAtomic({ path: pathB, meta: { id: newId('doc') }, body: 'b body' })
    await writeDocumentAtomic({ path: pathA, meta: { id: newId('doc') }, body: 'a body' })
    await writeFile(join(dir, 'notes.txt'), 'ignore me', 'utf8')

    const docs = await listDocuments(dir)
    expect(docs.map((d) => d.path)).toEqual([pathA, pathB])
    expect(docs.every((d) => typeof d.meta.id === 'string')).toBe(true)
  })
})

describe('paths and ensureMemoryTree', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openreverie-memory-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('memoryPaths derives all expected paths under root', () => {
    const paths = memoryPaths(dir)
    expect(paths.root).toBe(dir)
    expect(paths.constitution).toBe(join(dir, 'constitution.md'))
    expect(paths.realmsDir).toBe(join(dir, 'realms'))
    expect(paths.arcsDir).toBe(join(dir, 'arcs'))
    expect(paths.sessionsDir).toBe(join(dir, 'sessions'))
    expect(paths.rollupsDailyDir).toBe(join(dir, 'rollups', 'daily'))
    expect(paths.rollupsWeeklyDir).toBe(join(dir, 'rollups', 'weekly'))
    expect(paths.graphLog).toBe(join(dir, 'graph.jsonl'))
    expect(paths.proposals).toBe(join(dir, 'proposals.jsonl'))
    expect(paths.indexDb).toBe(join(dir, 'index.db'))
  })

  it('creates all directories and seeds constitution.md once', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const constitution = await readDocument(paths.constitution)
    expect(typeof constitution.meta.id).toBe('string')
    expect(constitution.body).toContain('This constitution is empty. It grows as we talk.')

    for (const d of [
      paths.realmsDir,
      paths.arcsDir,
      paths.sessionsDir,
      paths.rollupsDailyDir,
      paths.rollupsWeeklyDir,
    ]) {
      const stat = await readdir(d)
      expect(stat).toEqual([])
    }
  })

  it('is idempotent and does not reseed an existing constitution', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)
    const first = await readDocument(paths.constitution)

    await ensureMemoryTree(paths)
    const second = await readDocument(paths.constitution)

    expect(second.meta.id).toBe(first.meta.id)
  })

  it('seeds .gitignore with index.db and *.tmp-* patterns', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const gitignorePath = join(dir, '.gitignore')
    const content = await readFile(gitignorePath, 'utf8')
    expect(content).toBe('index.db\n*.tmp-*\n')
  })

  it('does not overwrite a user-modified .gitignore', async () => {
    const paths = memoryPaths(dir)
    await ensureMemoryTree(paths)

    const gitignorePath = join(dir, '.gitignore')
    const customContent = 'custom user content\n'
    await writeFile(gitignorePath, customContent, 'utf8')

    await ensureMemoryTree(paths)

    const content = await readFile(gitignorePath, 'utf8')
    expect(content).toBe(customContent)
  })
})
