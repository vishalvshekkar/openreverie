// The dream pipeline. Exploration here; outputs and writes in this same
// module (see runDream below, added with the output stage).
import type { ChatMessage, ChatProvider, ToolCall, ToolDefinition } from '@openreverie/providers'
import type { Document } from './documents.js'
import type { DocKind } from './sqlite.js'
import type { TranscriptLine } from './transcripts.js'

export interface DreamLookup {
  search(query: string, filters?: { kinds?: DocKind[] }, limit?: number): Promise<unknown>
  readDocumentById(docId: string): Promise<Document | null>
  readTranscript(sessionId: string): Promise<TranscriptLine[]>
  neighbors(nodeId: string): unknown
}

const DREAM_TOOLS: ToolDefinition[] = [
  {
    name: 'search_memory',
    description: 'Search the memory folder. Use to follow up on what the seeds raise.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_document',
    description: 'Read one document by docId.',
    parameters: {
      type: 'object',
      properties: { docId: { type: 'string' } },
      required: ['docId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_transcript',
    description: 'Read one session transcript by sessionId.',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'graph_query',
    description: 'List graph neighbors of a node by nodeId.',
    parameters: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
]

export const DREAM_EXPLORATION_INSTRUCTIONS = `## Dreaming: exploration

You are the reverie companion between conversations, turning over what this person has shared.
You have been handed a few seeds from their memory: distant things picked on purpose. Explore
what they raise. You may search, read documents and transcripts, and follow graph connections.

Restraint: follow the threads the seeds open. Reading the constitution is fine. Do not attempt
to read the whole record; a dream is made from a handful of things seen closely, not everything
seen at once. When you have enough to work with, stop calling tools and briefly note what
caught your attention.

A recorded intention is evidence the person said they meant to do something. It is never
evidence that they did it. Treat stated times ("come summer") as their words anchored to the
date they were said, never as resolved dates.`

async function dispatchDreamTool(lookup: DreamLookup, call: ToolCall): Promise<string> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>
  } catch {
    return JSON.stringify({ error: 'arguments were not valid JSON' })
  }
  try {
    switch (call.name) {
      case 'search_memory': {
        const kinds = Array.isArray(args.kinds) ? (args.kinds as DocKind[]) : undefined
        const result = await lookup.search(
          String(args.query ?? ''),
          kinds ? { kinds } : undefined,
          typeof args.limit === 'number' ? args.limit : undefined,
        )
        return JSON.stringify(result)
      }
      case 'read_document': {
        const doc = await lookup.readDocumentById(String(args.docId ?? ''))
        return doc === null
          ? JSON.stringify({ error: 'not found' })
          : JSON.stringify({ meta: doc.meta, body: doc.body })
      }
      case 'read_transcript':
        return JSON.stringify(await lookup.readTranscript(String(args.sessionId ?? '')))
      case 'graph_query':
        return JSON.stringify(lookup.neighbors(String(args.nodeId ?? '')))
      default:
        return JSON.stringify({ error: `unknown tool: ${call.name}` })
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

export async function runExploration(args: {
  chat: ChatProvider
  model: string
  persona: string
  lookup: DreamLookup
  maxToolCalls: number
  packet: string
  record: (event: Record<string, unknown>) => void
}): Promise<ChatMessage[]> {
  const system = `${args.persona}\n\n${DREAM_EXPLORATION_INSTRUCTIONS}`
  const messages: ChatMessage[] = [{ role: 'user', content: args.packet }]
  let used = 0
  let exhausted = false
  for (;;) {
    const result = await args.chat.complete({
      model: args.model,
      system,
      messages,
      tools: DREAM_TOOLS,
    })
    messages.push({
      role: 'assistant',
      content: result.text,
      ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
    })
    if (result.toolCalls.length === 0 || exhausted) return messages
    let refused = 0
    for (const call of result.toolCalls) {
      if (used >= args.maxToolCalls) {
        refused += 1
        messages.push({
          role: 'tool',
          content: JSON.stringify({ error: 'tool budget exhausted' }),
          toolCallId: call.id,
        })
        continue
      }
      used += 1
      args.record({ event: 'tool_call', name: call.name, arguments: call.arguments })
      const output = await dispatchDreamTool(args.lookup, call)
      messages.push({ role: 'tool', content: output, toolCallId: call.id })
    }
    if (used >= args.maxToolCalls && !exhausted) {
      exhausted = true
      args.record({ event: 'budget_exhausted', maxToolCalls: args.maxToolCalls, refused })
      messages.push({
        role: 'user',
        content:
          'The tool budget for this dream is used up. Stop exploring and note what caught your attention.',
      })
    }
  }
}
