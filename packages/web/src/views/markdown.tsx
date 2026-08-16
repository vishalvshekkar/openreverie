// biome-ignore-all lint/suspicious/noArrayIndexKey: blocks and inline parts are
// re-derived from the document body on every render, in a fixed order, with no
// reordering or identity-preserving update. Position is a stable key here.
import type { ReactNode } from 'react'

/*
 * A small, deliberately limited markdown renderer for openreverie's reading
 * view. It understands ATX headings (# through ###), paragraphs, unordered
 * and ordered lists, blockquotes, horizontal rules, fenced code blocks, and
 * inline code, bold, and italic. Anything it does not recognise is rendered
 * as plain text, never as raw HTML: there is no dangerouslySetInnerHTML
 * anywhere in this file, so React escapes every character it prints.
 */

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'blockquote'; text: string }
  | { type: 'hr' }
  | { type: 'code'; text: string }

const FENCE_RE = /^```/
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/
const HEADING_RE = /^(#{1,3})\s+(.+)$/
const UL_RE = /^[-*+]\s+(.+)$/
const OL_RE = /^\d+[.)]\s+(.+)$/
const BQ_RE = /^>\s?(.*)$/

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split('\n')
  // Every call site below only reaches this once a bounds check (i < lines.length)
  // has already passed, so the fallback is never actually used. It exists to
  // satisfy the type checker without a non-null assertion.
  const at = (index: number): string => lines[index] ?? ''
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = at(i)

    if (line.trim() === '') {
      i += 1
      continue
    }

    if (FENCE_RE.test(line)) {
      i += 1
      const codeLines: string[] = []
      while (i < lines.length && !FENCE_RE.test(at(i))) {
        codeLines.push(at(i))
        i += 1
      }
      if (i < lines.length) i += 1 // skip the closing fence
      blocks.push({ type: 'code', text: codeLines.join('\n') })
      continue
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = (heading[1] ?? '').length as 1 | 2 | 3
      blocks.push({ type: 'heading', level, text: (heading[2] ?? '').trim() })
      i += 1
      continue
    }

    if (UL_RE.test(line)) {
      const items: string[] = []
      while (i < lines.length) {
        const match = UL_RE.exec(at(i))
        if (!match) break
        items.push(match[1] ?? '')
        i += 1
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    if (OL_RE.test(line)) {
      const items: string[] = []
      while (i < lines.length) {
        const match = OL_RE.exec(at(i))
        if (!match) break
        items.push(match[1] ?? '')
        i += 1
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    if (BQ_RE.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length) {
        const match = BQ_RE.exec(at(i))
        if (!match) break
        quoteLines.push(match[1] ?? '')
        i += 1
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join(' ').trim() })
      continue
    }

    const paraLines: string[] = []
    while (
      i < lines.length &&
      at(i).trim() !== '' &&
      !FENCE_RE.test(at(i)) &&
      !HR_RE.test(at(i)) &&
      !HEADING_RE.test(at(i)) &&
      !UL_RE.test(at(i)) &&
      !OL_RE.test(at(i)) &&
      !BQ_RE.test(at(i))
    ) {
      paraLines.push(at(i))
      i += 1
    }
    blocks.push({ type: 'paragraph', text: paraLines.join(' ').trim() })
  }

  return blocks
}

// Underscore emphasis is only recognised at a word boundary. Without this,
// an id like "doc_const_1" would be misread as "doc" + <em>const</em> + "1",
// splitting a single piece of text into several nodes. Asterisks have no
// such restriction, matching common markdown convention.
const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|(?<!\w)__[^_]+__(?!\w)|\*[^*]+\*|(?<!\w)_[^_]+_(?!\w))/g

export function renderInline(text: string): ReactNode[] {
  return text
    .split(INLINE_RE)
    .filter((part) => part !== '')
    .map((part, index) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
        return <code key={index}>{part.slice(1, -1)}</code>
      }
      if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
        return <strong key={index}>{part.slice(2, -2)}</strong>
      }
      if (part.startsWith('__') && part.endsWith('__') && part.length >= 4) {
        return <strong key={index}>{part.slice(2, -2)}</strong>
      }
      if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
        return <em key={index}>{part.slice(1, -1)}</em>
      }
      if (part.startsWith('_') && part.endsWith('_') && part.length >= 2) {
        return <em key={index}>{part.slice(1, -1)}</em>
      }
      return part
    })
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source)
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading': {
            if (block.level === 1) return <h1 key={index}>{renderInline(block.text)}</h1>
            if (block.level === 2) return <h2 key={index}>{renderInline(block.text)}</h2>
            return <h3 key={index}>{renderInline(block.text)}</h3>
          }
          case 'paragraph':
            return <p key={index}>{renderInline(block.text)}</p>
          case 'list':
            return block.ordered ? (
              <ol key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </ol>
            ) : (
              <ul key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </ul>
            )
          case 'blockquote':
            return (
              <blockquote key={index}>
                <p>{renderInline(block.text)}</p>
              </blockquote>
            )
          case 'hr':
            return <hr key={index} />
          case 'code':
            return (
              <pre key={index}>
                <code>{block.text}</code>
              </pre>
            )
          default:
            return null
        }
      })}
    </>
  )
}
